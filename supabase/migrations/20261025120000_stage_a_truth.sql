-- =============================================================================
-- ETAPA A — VERDAD
-- 1) Pedidos atómicos e idempotentes
-- 2) Dedupe de mensajes entrantes
-- 3) Estado de conversación tipado
-- Idempotente: se puede aplicar dos veces sin efectos adversos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Idempotencia de pedidos
-- -----------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Un índice UNIQUE normal permite múltiples NULL; solo protege claves reales.
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_key
    ON public.orders (idempotency_key);

COMMENT ON COLUMN public.orders.idempotency_key IS
    'Clave derivada de conversación + mensaje + ítems. Evita pedidos duplicados por reintentos.';

-- -----------------------------------------------------------------------------
-- 2. Dedupe de mensajes entrantes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    provider_message_id TEXT NOT NULL CHECK (length(trim(provider_message_id)) > 0),
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
    last_error TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_status
    ON public.inbound_messages (status, updated_at);

ALTER TABLE public.inbound_messages ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_inbound_message(
    p_provider TEXT,
    p_message_id TEXT,
    p_conversation_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
    v_status TEXT;
    v_updated_at TIMESTAMPTZ;
BEGIN
    IF p_provider IS NULL OR length(trim(p_provider)) = 0
       OR p_message_id IS NULL OR length(trim(p_message_id)) = 0 THEN
        RAISE EXCEPTION 'INVALID_MESSAGE_ID';
    END IF;

    INSERT INTO public.inbound_messages (provider, provider_message_id, conversation_id)
    VALUES (p_provider, p_message_id, p_conversation_id)
    ON CONFLICT (provider, provider_message_id) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
        RETURN TRUE;
    END IF;

    SELECT id, status, updated_at
      INTO v_id, v_status, v_updated_at
      FROM public.inbound_messages
     WHERE provider = p_provider
       AND provider_message_id = p_message_id
     FOR UPDATE;

    -- Ya procesado: no se repite.
    IF v_status = 'done' THEN
        RETURN FALSE;
    END IF;

    -- En proceso y reciente: otro worker lo tiene.
    IF v_status = 'processing' AND v_updated_at > NOW() - INTERVAL '5 minutes' THEN
        RETURN FALSE;
    END IF;

    -- Falló o quedó colgado: se permite un reintento.
    UPDATE public.inbound_messages
       SET status = 'processing',
           attempts = attempts + 1,
           last_error = NULL,
           conversation_id = COALESCE(p_conversation_id, conversation_id),
           updated_at = NOW()
     WHERE id = v_id;

    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_inbound_message(
    p_provider TEXT,
    p_message_id TEXT,
    p_status TEXT,
    p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_status NOT IN ('done', 'failed') THEN
        RAISE EXCEPTION 'INVALID_FINAL_STATUS';
    END IF;

    UPDATE public.inbound_messages
       SET status = p_status,
           last_error = p_error,
           updated_at = NOW()
     WHERE provider = p_provider
       AND provider_message_id = p_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Estado de conversación tipado
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_state (
    conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'browsing'
        CHECK (stage IN (
            'browsing',
            'selecting',
            'collecting_shipping',
            'awaiting_payment',
            'receipt_received',
            'under_review',
            'paid',
            'human_takeover',
            'closed'
        )),
    active_product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    active_variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
    last_intent TEXT,
    pending_action JSONB,
    handoff_status TEXT NOT NULL DEFAULT 'bot'
        CHECK (handoff_status IN ('bot', 'waiting_human', 'human')),
    bot_paused_until TIMESTAMPTZ,
    summary TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_stage
    ON public.conversation_state (stage, updated_at DESC);

ALTER TABLE public.conversation_state ENABLE ROW LEVEL SECURITY;

-- Solo administradores pueden leer el estado desde el cliente.
DROP POLICY IF EXISTS "Admins read conversation state" ON public.conversation_state;
CREATE POLICY "Admins read conversation state"
    ON public.conversation_state
    FOR SELECT
    TO authenticated
    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 4. Creación atómica de pedido
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_order_atomic(
    p_customer_id UUID,
    p_items JSONB,
    p_shipping JSONB,
    p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order_id UUID;
    v_existing public.orders%ROWTYPE;
    v_item JSONB;
    v_product_id UUID;
    v_size NUMERIC;
    v_qty INTEGER;
    v_variant_id UUID;
    v_price INTEGER;
    v_stock INTEGER;
    v_reserved INTEGER;
    v_total INTEGER := 0;
    v_item_count INTEGER := 0;
    v_quantity INTEGER := 0;
    v_reference TEXT;
    v_name TEXT := NULLIF(trim(COALESCE(p_shipping->>'name', '')), '');
    v_city TEXT := NULLIF(trim(COALESCE(p_shipping->>'city', '')), '');
    v_address TEXT := NULLIF(trim(COALESCE(p_shipping->>'address', '')), '');
BEGIN
    -- Contrato de entrada
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 8 THEN
        RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
    END IF;

    IF v_name IS NULL OR v_city IS NULL OR v_address IS NULL THEN
        RAISE EXCEPTION 'INVALID_SHIPPING';
    END IF;

    IF p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'INVALID_ITEM';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
    END IF;

    -- Insertar la orden primero. Si la clave ya existe, no se toca nada.
    INSERT INTO public.orders (
        customer_id,
        status,
        shipping_name,
        shipping_city,
        shipping_address,
        subtotal_cents,
        total_cents,
        payment_reference,
        idempotency_key
    )
    VALUES (
        p_customer_id,
        'awaiting_payment',
        v_name,
        v_city,
        v_address,
        0,
        0,
        NULL,
        p_idempotency_key
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_order_id;

    IF v_order_id IS NULL THEN
        SELECT * INTO v_existing
          FROM public.orders
         WHERE idempotency_key = p_idempotency_key;

        RETURN jsonb_build_object(
            'success', TRUE,
            'order_id', v_existing.id,
            'payment_reference', v_existing.payment_reference,
            'total_cents', v_existing.total_cents,
            'item_count', (
                SELECT count(*) FROM public.order_items WHERE order_id = v_existing.id
            ),
            'quantity', COALESCE((
                SELECT sum(qty) FROM public.order_items WHERE order_id = v_existing.id
            ), 0),
            'deduplicated', TRUE
        );
    END IF;

    -- Referencia legible y no predecible.
    v_reference := 'ORD-'
        || to_char(NOW() AT TIME ZONE 'America/Bogota', 'YYYYMMDDHH24MISS')
        || '-'
        || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    UPDATE public.orders
       SET payment_reference = v_reference,
           updated_at = NOW()
     WHERE id = v_order_id;

    -- Resolver, bloquear y reservar cada ítem.
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        BEGIN
            v_product_id := (v_item->>'product_id')::UUID;
            v_size := (v_item->>'size')::NUMERIC;
            v_qty := COALESCE((v_item->>'quantity')::INTEGER, 0);
        EXCEPTION WHEN others THEN
            RAISE EXCEPTION 'INVALID_ITEM';
        END;

        IF v_product_id IS NULL OR v_size IS NULL OR v_qty < 1 OR v_qty > 10 THEN
            RAISE EXCEPTION 'INVALID_ITEM';
        END IF;

        SELECT pv.id, pv.stock, pv.reserved, p.price_cents
          INTO v_variant_id, v_stock, v_reserved, v_price
          FROM public.product_variants pv
          JOIN public.products p ON p.id = pv.product_id
         WHERE pv.product_id = v_product_id
           AND pv.size = v_size
           AND p.active = TRUE
         FOR UPDATE OF pv;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_VARIANT_NOT_FOUND';
        END IF;

        IF (v_stock - v_reserved) < v_qty THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK';
        END IF;

        INSERT INTO public.order_items (
            order_id, product_id, variant_id, qty, unit_price_cents
        )
        VALUES (
            v_order_id, v_product_id, v_variant_id, v_qty, v_price
        );

        UPDATE public.product_variants
           SET reserved = reserved + v_qty,
               updated_at = NOW()
         WHERE id = v_variant_id;

        v_total := v_total + (v_price * v_qty);
        v_item_count := v_item_count + 1;
        v_quantity := v_quantity + v_qty;
    END LOOP;

    UPDATE public.orders
       SET subtotal_cents = v_total,
           total_cents = v_total,
           updated_at = NOW()
     WHERE id = v_order_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'order_id', v_order_id,
        'payment_reference', v_reference,
        'total_cents', v_total,
        'item_count', v_item_count,
        'quantity', v_quantity,
        'deduplicated', FALSE
    );
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT) TO service_role;

COMMENT ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT) IS
    'Crea orden + items + reserva de stock en una transacción. Idempotente por p_idempotency_key.';
