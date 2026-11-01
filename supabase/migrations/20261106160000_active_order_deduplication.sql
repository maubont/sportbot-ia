-- Prevent a second active order with the same customer, normalized cart and
-- shipping details, even when the provider delivers a new message ID.
-- New identical purchases are allowed after delivery, cancellation or expiry.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_orders_active_duplicate_customer
    ON public.orders (customer_id, status, created_at DESC)
    WHERE status IN ('awaiting_payment', 'paid', 'processing', 'shipped');

CREATE INDEX IF NOT EXISTS idx_order_items_active_duplicate_lookup
    ON public.order_items (order_id, product_id, variant_id);

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
    v_requested_items JSONB;
    v_shipping_key JSONB;
    v_name TEXT := NULLIF(trim(COALESCE(p_shipping->>'name', '')), '');
    v_city TEXT := NULLIF(trim(COALESCE(p_shipping->>'city', '')), '');
    v_address TEXT := NULLIF(trim(COALESCE(p_shipping->>'address', '')), '');
BEGIN
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

    -- Validate each raw line before aggregation so malformed input cannot be
    -- treated as an existing duplicate or reach the stock-reservation loop.
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
    END LOOP;

    -- Serialize order creation per customer. This closes the race where two
    -- different inbound message IDs attempt the same active purchase at once.
    PERFORM 1
      FROM public.customers
     WHERE id = p_customer_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
    END IF;

    -- Canonical item identity is the aggregated product+size+quantity set.
    -- Split lines and item order therefore do not bypass duplicate detection.
    SELECT jsonb_agg(
               jsonb_build_object(
                   'product_id', requested.product_id::TEXT,
                   'size', trim_scale(requested.size),
                   'quantity', requested.quantity
               )
               ORDER BY requested.product_id::TEXT, requested.size
           )
      INTO v_requested_items
      FROM (
          SELECT (item->>'product_id')::UUID AS product_id,
                 trim_scale((item->>'size')::NUMERIC) AS size,
                 SUM((item->>'quantity')::INTEGER)::BIGINT AS quantity
            FROM jsonb_array_elements(p_items) AS entries(item)
           GROUP BY 1, 2
      ) AS requested;

    v_shipping_key := jsonb_build_object(
        'name', lower(regexp_replace(v_name, '[[:space:]]+', ' ', 'g')),
        'city', lower(regexp_replace(v_city, '[[:space:]]+', ' ', 'g')),
        'address', lower(regexp_replace(v_address, '[[:space:]]+', ' ', 'g'))
    );

    -- Only an order still in its purchase/fulfilment lifecycle blocks an
    -- identical retry. Terminal orders (delivered/cancelled/expired) do not.
    SELECT o.*
      INTO v_existing
      FROM public.orders o
     WHERE o.customer_id = p_customer_id
       AND o.status IN ('awaiting_payment', 'paid', 'processing', 'shipped')
       AND o.delivered_at IS NULL
       AND o.payment_reference IS NOT NULL
       AND jsonb_build_object(
               'name', lower(regexp_replace(trim(COALESCE(o.shipping_name, '')), '[[:space:]]+', ' ', 'g')),
               'city', lower(regexp_replace(trim(COALESCE(o.shipping_city, '')), '[[:space:]]+', ' ', 'g')),
               'address', lower(regexp_replace(trim(COALESCE(o.shipping_address, '')), '[[:space:]]+', ' ', 'g'))
           ) = v_shipping_key
       AND COALESCE((
               SELECT jsonb_agg(
                          jsonb_build_object(
                              'product_id', existing_items.product_id::TEXT,
                              'size', trim_scale(existing_items.size),
                              'quantity', existing_items.quantity
                          )
                          ORDER BY existing_items.product_id::TEXT, existing_items.size
                      )
                 FROM (
                     SELECT oi.product_id,
                            pv.size AS size,
                            SUM(oi.qty)::BIGINT AS quantity
                       FROM public.order_items oi
                       JOIN public.product_variants pv
                         ON pv.id = oi.variant_id
                        AND pv.product_id = oi.product_id
                      WHERE oi.order_id = o.id
                      GROUP BY oi.product_id, pv.size
                 ) AS existing_items
           ), '[]'::JSONB) = v_requested_items
     ORDER BY o.created_at DESC
     LIMIT 1
     FOR UPDATE OF o;

    IF FOUND THEN
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
            'deduplicated', TRUE,
            'duplicate_reason', 'active_identical_order'
        );
    END IF;

    -- Preserve strict same-event idempotency independently of the business rule.
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
         WHERE idempotency_key = p_idempotency_key
         FOR UPDATE;

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
            'deduplicated', TRUE,
            'duplicate_reason', 'same_inbound_message'
        );
    END IF;

    v_reference := 'ORD-'
        || to_char(NOW() AT TIME ZONE 'America/Bogota', 'YYYYMMDDHH24MISS')
        || '-'
        || upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 6));

    UPDATE public.orders
       SET payment_reference = v_reference,
           updated_at = NOW()
     WHERE id = v_order_id;

    -- Resolve, lock and reserve every requested product variant atomically.
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_size := (v_item->>'size')::NUMERIC;
        v_qty := (v_item->>'quantity')::INTEGER;

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

REVOKE ALL ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT) IS
    'Crea orden, items y reserva de stock en una transacción. Deduplica por evento y bloquea una orden idéntica mientras otra orden del mismo cliente siga activa.';

NOTIFY pgrst, 'reload schema';
COMMIT;
