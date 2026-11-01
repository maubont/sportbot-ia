-- Unit economics v1: cost snapshots, variable costs and order margin summaries.
-- Sensitive product costs are kept out of public catalog tables.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon;
REVOKE ALL ON SCHEMA private FROM authenticated;

CREATE TABLE IF NOT EXISTS public.product_costs (
    product_id UUID PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
    default_unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_unit_cost_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'COP',
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'estimate', 'system')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.order_items
ADD COLUMN IF NOT EXISTS unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0);

CREATE TABLE IF NOT EXISTS public.order_variable_costs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    cost_type TEXT NOT NULL CHECK (
        cost_type IN (
            'payment_fee',
            'shipping_real',
            'packaging',
            'discount',
            'twilio',
            'openai',
            'other'
        )
    ),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'COP',
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'system', 'wompi', 'twilio', 'openai', 'carrier', 'estimate')),
    external_ref TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT order_variable_costs_external_ref_key UNIQUE (order_id, cost_type, source, external_ref)
);

CREATE TABLE IF NOT EXISTS public.order_economics (
    order_id UUID PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
    currency TEXT NOT NULL DEFAULT 'COP',
    revenue_cents INTEGER NOT NULL DEFAULT 0,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    shipping_charged_cents INTEGER NOT NULL DEFAULT 0,
    cogs_cents INTEGER NOT NULL DEFAULT 0,
    payment_fee_cents INTEGER NOT NULL DEFAULT 0,
    shipping_real_cost_cents INTEGER NOT NULL DEFAULT 0,
    packaging_cost_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    twilio_cost_cents INTEGER NOT NULL DEFAULT 0,
    ai_cost_cents INTEGER NOT NULL DEFAULT 0,
    other_variable_cost_cents INTEGER NOT NULL DEFAULT 0,
    variable_cost_cents INTEGER NOT NULL DEFAULT 0,
    gross_margin_cents INTEGER NOT NULL DEFAULT 0,
    contribution_margin_cents INTEGER NOT NULL DEFAULT 0,
    contribution_margin_bps INTEGER NOT NULL DEFAULT 0,
    data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_variable_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_economics ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.product_costs FROM PUBLIC;
REVOKE ALL ON public.order_variable_costs FROM PUBLIC;
REVOKE ALL ON public.order_economics FROM PUBLIC;
REVOKE ALL ON public.product_costs FROM anon;
REVOKE ALL ON public.order_variable_costs FROM anon;
REVOKE ALL ON public.order_economics FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_costs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_variable_costs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_economics TO authenticated;

DROP POLICY IF EXISTS "Admins manage product costs" ON public.product_costs;
CREATE POLICY "Admins manage product costs"
ON public.product_costs
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage order variable costs" ON public.order_variable_costs;
CREATE POLICY "Admins manage order variable costs"
ON public.order_variable_costs
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage order economics" ON public.order_economics;
CREATE POLICY "Admins manage order economics"
ON public.order_economics
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE INDEX IF NOT EXISTS order_variable_costs_order_type_idx
ON public.order_variable_costs (order_id, cost_type);

CREATE INDEX IF NOT EXISTS order_economics_contribution_idx
ON public.order_economics (contribution_margin_cents);

CREATE OR REPLACE FUNCTION private.touch_unit_economics_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_product_costs_updated_at ON public.product_costs;
CREATE TRIGGER touch_product_costs_updated_at
BEFORE UPDATE ON public.product_costs
FOR EACH ROW
EXECUTE FUNCTION private.touch_unit_economics_updated_at();

DROP TRIGGER IF EXISTS touch_order_variable_costs_updated_at ON public.order_variable_costs;
CREATE TRIGGER touch_order_variable_costs_updated_at
BEFORE UPDATE ON public.order_variable_costs
FOR EACH ROW
EXECUTE FUNCTION private.touch_unit_economics_updated_at();

CREATE OR REPLACE FUNCTION private.apply_order_item_cost_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    resolved_cost_cents INTEGER;
BEGIN
    IF COALESCE(NEW.unit_cost_cents, 0) <= 0 THEN
        SELECT COALESCE(pc.default_unit_cost_cents, 0)
        INTO resolved_cost_cents
        FROM public.products p
        LEFT JOIN public.product_variants pv ON pv.id = NEW.variant_id
        LEFT JOIN public.product_costs pc ON pc.product_id = p.id
        WHERE p.id = COALESCE(NEW.product_id, pv.product_id)
        LIMIT 1;

        NEW.unit_cost_cents = COALESCE(resolved_cost_cents, 0);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_order_item_cost_snapshot ON public.order_items;
CREATE TRIGGER apply_order_item_cost_snapshot
BEFORE INSERT OR UPDATE OF product_id, variant_id, unit_cost_cents ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION private.apply_order_item_cost_snapshot();

CREATE OR REPLACE FUNCTION private.refresh_order_economics(target_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    order_row RECORD;
    item_count INTEGER := 0;
    cogs INTEGER := 0;
    payment_fee INTEGER := 0;
    shipping_real INTEGER := 0;
    packaging INTEGER := 0;
    discounts INTEGER := 0;
    twilio INTEGER := 0;
    openai_cost INTEGER := 0;
    other_cost INTEGER := 0;
    variable_cost INTEGER := 0;
    revenue INTEGER := 0;
    subtotal INTEGER := 0;
    shipping_charged INTEGER := 0;
    gross_margin INTEGER := 0;
    contribution_margin INTEGER := 0;
    contribution_margin_bps INTEGER := 0;
    flags TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT *
    INTO order_row
    FROM public.orders
    WHERE id = target_order_id;

    IF NOT FOUND THEN
        DELETE FROM public.order_economics WHERE order_id = target_order_id;
        RETURN;
    END IF;

    SELECT COUNT(*), COALESCE(SUM(COALESCE(unit_cost_cents, 0) * COALESCE(qty, 0)), 0)
    INTO item_count, cogs
    FROM public.order_items
    WHERE order_id = target_order_id;

    SELECT
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'payment_fee'), 0),
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'shipping_real'), 0),
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'packaging'), 0),
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'discount'), 0),
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'twilio'), 0),
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'openai'), 0),
        COALESCE(SUM(amount_cents) FILTER (WHERE cost_type = 'other'), 0)
    INTO payment_fee, shipping_real, packaging, discounts, twilio, openai_cost, other_cost
    FROM public.order_variable_costs
    WHERE order_id = target_order_id;

    revenue := COALESCE(order_row.total_cents, 0);
    subtotal := COALESCE(order_row.subtotal_cents, 0);
    shipping_charged := COALESCE(order_row.shipping_cost_cents, 0);
    variable_cost := payment_fee + shipping_real + packaging + discounts + twilio + openai_cost + other_cost;
    gross_margin := revenue - cogs;
    contribution_margin := revenue - cogs - variable_cost;

    IF revenue > 0 THEN
        contribution_margin_bps := ROUND((contribution_margin::numeric / revenue::numeric) * 10000)::integer;
    END IF;

    IF item_count = 0 THEN
        flags := array_append(flags, 'missing_items');
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.order_items
        WHERE order_id = target_order_id
          AND COALESCE(qty, 0) > 0
          AND COALESCE(unit_cost_cents, 0) = 0
    ) THEN
        flags := array_append(flags, 'missing_cogs');
    END IF;

    IF order_row.status IN ('paid', 'processing', 'shipped', 'delivered') AND payment_fee = 0 THEN
        flags := array_append(flags, 'missing_payment_fee');
    END IF;

    IF order_row.status IN ('shipped', 'delivered') AND shipping_real = 0 THEN
        flags := array_append(flags, 'missing_shipping_real_cost');
    END IF;

    IF contribution_margin < 0 THEN
        flags := array_append(flags, 'negative_contribution_margin');
    END IF;

    INSERT INTO public.order_economics (
        order_id,
        revenue_cents,
        subtotal_cents,
        shipping_charged_cents,
        cogs_cents,
        payment_fee_cents,
        shipping_real_cost_cents,
        packaging_cost_cents,
        discount_cents,
        twilio_cost_cents,
        ai_cost_cents,
        other_variable_cost_cents,
        variable_cost_cents,
        gross_margin_cents,
        contribution_margin_cents,
        contribution_margin_bps,
        data_quality_flags,
        calculated_at,
        updated_at
    )
    VALUES (
        target_order_id,
        revenue,
        subtotal,
        shipping_charged,
        cogs,
        payment_fee,
        shipping_real,
        packaging,
        discounts,
        twilio,
        openai_cost,
        other_cost,
        variable_cost,
        gross_margin,
        contribution_margin,
        contribution_margin_bps,
        flags,
        NOW(),
        NOW()
    )
    ON CONFLICT (order_id)
    DO UPDATE SET
        revenue_cents = EXCLUDED.revenue_cents,
        subtotal_cents = EXCLUDED.subtotal_cents,
        shipping_charged_cents = EXCLUDED.shipping_charged_cents,
        cogs_cents = EXCLUDED.cogs_cents,
        payment_fee_cents = EXCLUDED.payment_fee_cents,
        shipping_real_cost_cents = EXCLUDED.shipping_real_cost_cents,
        packaging_cost_cents = EXCLUDED.packaging_cost_cents,
        discount_cents = EXCLUDED.discount_cents,
        twilio_cost_cents = EXCLUDED.twilio_cost_cents,
        ai_cost_cents = EXCLUDED.ai_cost_cents,
        other_variable_cost_cents = EXCLUDED.other_variable_cost_cents,
        variable_cost_cents = EXCLUDED.variable_cost_cents,
        gross_margin_cents = EXCLUDED.gross_margin_cents,
        contribution_margin_cents = EXCLUDED.contribution_margin_cents,
        contribution_margin_bps = EXCLUDED.contribution_margin_bps,
        data_quality_flags = EXCLUDED.data_quality_flags,
        calculated_at = EXCLUDED.calculated_at,
        updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_order_economics_from_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.order_economics WHERE order_id = OLD.id;
        RETURN OLD;
    END IF;

    PERFORM private.refresh_order_economics(NEW.id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_order_economics_from_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM private.refresh_order_economics(OLD.order_id);
        RETURN OLD;
    END IF;

    PERFORM private.refresh_order_economics(NEW.order_id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_order_economics_from_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM private.refresh_order_economics(OLD.order_id);
        RETURN OLD;
    END IF;

    PERFORM private.refresh_order_economics(NEW.order_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_order_economics_from_order ON public.orders;
CREATE TRIGGER refresh_order_economics_from_order
AFTER INSERT OR UPDATE OF status, subtotal_cents, total_cents, shipping_cost_cents ON public.orders
FOR EACH ROW
EXECUTE FUNCTION private.refresh_order_economics_from_order();

DROP TRIGGER IF EXISTS delete_order_economics_from_order ON public.orders;
CREATE TRIGGER delete_order_economics_from_order
AFTER DELETE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION private.refresh_order_economics_from_order();

DROP TRIGGER IF EXISTS refresh_order_economics_from_item ON public.order_items;
CREATE TRIGGER refresh_order_economics_from_item
AFTER INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION private.refresh_order_economics_from_item();

DROP TRIGGER IF EXISTS refresh_order_economics_from_cost ON public.order_variable_costs;
CREATE TRIGGER refresh_order_economics_from_cost
AFTER INSERT OR UPDATE OR DELETE ON public.order_variable_costs
FOR EACH ROW
EXECUTE FUNCTION private.refresh_order_economics_from_cost();

UPDATE public.order_items oi
SET unit_cost_cents = COALESCE(pc.default_unit_cost_cents, 0)
FROM public.products p
LEFT JOIN public.product_costs pc ON pc.product_id = p.id
WHERE oi.product_id = p.id
  AND COALESCE(oi.unit_cost_cents, 0) = 0;

DO $$
DECLARE
    order_row_id UUID;
BEGIN
    FOR order_row_id IN SELECT id FROM public.orders LOOP
        PERFORM private.refresh_order_economics(order_row_id);
    END LOOP;
END $$;

COMMENT ON TABLE public.product_costs IS 'Admin-only product cost defaults used to snapshot COGS into order_items.';
COMMENT ON COLUMN public.order_items.unit_cost_cents IS 'Snapshot of unit product cost at order creation time.';
COMMENT ON TABLE public.order_variable_costs IS 'Order-level variable costs such as Wompi fees, real shipping, packaging, discounts, Twilio and OpenAI.';
COMMENT ON TABLE public.order_economics IS 'Calculated order unit economics summary for profitability and operations dashboards.';
