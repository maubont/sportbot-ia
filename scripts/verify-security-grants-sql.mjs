#!/usr/bin/env node
/**
 * Verifica grants, RLS financiero y la frontera de escritura de pedidos.
 *
 * Reproduce policies permisivas del baseline, aplica las migraciones de
 * revocación/hardening y valida anon, authenticated, operator, owner y
 * service_role con PGlite.
 *
 * Uso: node scripts/verify-security-grants-sql.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
    join(root, "supabase", "migrations", "20261101130000_revoke_anon_mutating_grants.sql"),
    "utf8",
);
const hardeningMigration = readFileSync(
    join(root, "supabase", "migrations", "20261106130000_security_order_hardening.sql"),
    "utf8",
);

const db = new PGlite();
let checks = 0;

async function execPrivilege(role, signature) {
    const result = await db.query(
        "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
        [role, signature],
    );
    return result.rows[0].allowed;
}

async function tablePrivilege(role, table, privilege) {
    const result = await db.query(
        "select has_table_privilege($1, $2, $3) as allowed",
        [role, `public.${table}`, privilege],
    );
    return result.rows[0].allowed;
}

async function rowCount(sql) {
    const result = await db.query(sql);
    return result.rows[0].count;
}

async function runAs(role, userId, action) {
    await db.exec(`SET ROLE ${role}`);
    await db.query(
        "SELECT set_config('request.jwt.claim.sub', $1, false)",
        [userId],
    );
    try {
        return await action();
    } finally {
        await db.exec("RESET ROLE");
    }
}

async function expectDenied(action) {
    try {
        await action();
        return false;
    } catch {
        return true;
    }
}

try {
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth;
        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

        CREATE FUNCTION auth.uid() RETURNS UUID
        LANGUAGE sql STABLE AS $$
            SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        CREATE FUNCTION auth.role() RETURNS TEXT
        LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
        GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
        GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;

        CREATE TABLE public.admin_users (
            user_id uuid PRIMARY KEY,
            role text NOT NULL,
            email text
        );
        INSERT INTO public.admin_users (user_id, role, email) VALUES
            ('00000000-0000-0000-0000-000000000001', 'owner', 'owner@example.test'),
            ('00000000-0000-0000-0000-000000000002', 'operator', 'operator@example.test');

        CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            SELECT EXISTS (
                SELECT 1 FROM public.admin_users
                WHERE user_id = auth.uid()
            )
        $$;

        CREATE FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
        RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
        CREATE FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID)
        RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;
        CREATE FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT)
        RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
        CREATE FUNCTION public.sync_order_logistics_from_shipment()
        RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;

        CREATE TABLE public.products (id integer primary key);
        CREATE TABLE public.product_variants (id integer primary key);
        CREATE TABLE public.product_media (id integer primary key);
        CREATE TABLE public.orders (id integer primary key, status text);
        CREATE TABLE public.order_items (id integer primary key, order_id integer);
        CREATE TABLE public.payments (id integer primary key, order_id integer);
        CREATE TABLE public.product_costs (id integer primary key, amount_cents integer);
        CREATE TABLE public.order_variable_costs (id integer primary key, amount_cents integer);
        CREATE TABLE public.order_economics (id integer primary key, margin_cents integer);

        INSERT INTO public.orders VALUES (1, 'awaiting_payment');
        INSERT INTO public.order_items VALUES (1, 1);
        INSERT INTO public.payments VALUES (1, 1);
        INSERT INTO public.product_costs VALUES (1, 50000);
        INSERT INTO public.order_variable_costs VALUES (1, 1000);
        INSERT INTO public.order_economics VALUES (1, 25000);

        ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.order_variable_costs ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.order_economics ENABLE ROW LEVEL SECURITY;

        -- Policies that reproduce the permissive baseline. Since permissive
        -- policies are OR-combined, adding a narrower policy cannot fix these.
        CREATE POLICY "Admin Full Access Orders" ON public.orders
            FOR ALL TO authenticated USING (auth.role() = 'authenticated')
            WITH CHECK (auth.role() = 'authenticated');
        CREATE POLICY "Admin Full Access Order Items" ON public.order_items
            FOR ALL TO authenticated USING (auth.role() = 'authenticated')
            WITH CHECK (auth.role() = 'authenticated');
        CREATE POLICY "Admin Full Access Payments" ON public.payments
            FOR ALL TO authenticated USING (auth.role() = 'authenticated')
            WITH CHECK (auth.role() = 'authenticated');
        CREATE POLICY "Admin Full Access Product Costs" ON public.product_costs
            FOR ALL TO authenticated USING (auth.role() = 'authenticated')
            WITH CHECK (auth.role() = 'authenticated');
        CREATE POLICY "Admin Full Access Order Variable Costs" ON public.order_variable_costs
            FOR ALL TO authenticated USING (auth.role() = 'authenticated')
            WITH CHECK (auth.role() = 'authenticated');
        CREATE POLICY "Admin Full Access Order Economics" ON public.order_economics
            FOR ALL TO authenticated USING (auth.role() = 'authenticated')
            WITH CHECK (auth.role() = 'authenticated');

        -- Current pre-hardening policies; these alone still admitted operators.
        CREATE POLICY "Admins manage orders" ON public.orders
            FOR ALL TO authenticated USING (public.is_admin())
            WITH CHECK (public.is_admin());
        CREATE POLICY "Admins manage order items" ON public.order_items
            FOR ALL TO authenticated USING (public.is_admin())
            WITH CHECK (public.is_admin());
        CREATE POLICY "Admins manage payments" ON public.payments
            FOR ALL TO authenticated USING (public.is_admin())
            WITH CHECK (public.is_admin());
        CREATE POLICY "Admins manage product costs" ON public.product_costs
            FOR ALL TO authenticated USING (public.is_admin())
            WITH CHECK (public.is_admin());
        CREATE POLICY "Admins manage order variable costs" ON public.order_variable_costs
            FOR ALL TO authenticated USING (public.is_admin())
            WITH CHECK (public.is_admin());
        CREATE POLICY "Admins manage order economics" ON public.order_economics
            FOR ALL TO authenticated USING (public.is_admin())
            WITH CHECK (public.is_admin());

        -- Model inherited Supabase grants before applying the migrations.
        GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;
        GRANT EXECUTE ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
            TO anon, authenticated, PUBLIC;
        GRANT EXECUTE ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID)
            TO anon, authenticated, PUBLIC;
        GRANT EXECUTE ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT)
            TO anon, authenticated, PUBLIC;
        GRANT EXECUTE ON FUNCTION public.sync_order_logistics_from_shipment()
            TO anon, authenticated, PUBLIC;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);

    await db.exec(migration);
    await db.exec(hardeningMigration);

    const mutating = [
        "public.create_order_atomic(UUID, JSONB, JSONB, TEXT)",
        "public.claim_inbound_message(TEXT, TEXT, UUID)",
        "public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT)",
        "public.sync_order_logistics_from_shipment()",
    ];
    for (const signature of mutating) {
        assert.equal(await execPrivilege("anon", signature), false, `anon no debe ejecutar ${signature}`); checks++;
        assert.equal(await execPrivilege("authenticated", signature), false, `authenticated no debe ejecutar ${signature}`); checks++;
    }
    assert.equal(await execPrivilege("service_role", mutating[0]), true, "service_role crea pedidos"); checks++;
    assert.equal(await execPrivilege("service_role", mutating[1]), true, "service_role deduplica inbound"); checks++;
    assert.equal(await execPrivilege("service_role", mutating[2]), true, "service_role finaliza inbound"); checks++;
    assert.equal(await execPrivilege("anon", "public.is_admin()"), true, "RLS conserva is_admin ejecutable"); checks++;

    assert.equal(await tablePrivilege("anon", "orders", "SELECT"), false, "anon no lee pedidos"); checks++;
    assert.equal(await tablePrivilege("anon", "orders", "INSERT"), false, "anon no crea pedidos"); checks++;
    assert.equal(await tablePrivilege("anon", "payments", "UPDATE"), false, "anon no edita pagos"); checks++;
    assert.equal(await tablePrivilege("anon", "product_costs", "SELECT"), false, "anon no lee costos"); checks++;
    assert.equal(await tablePrivilege("anon", "products", "SELECT"), true, "anon lee catálogo"); checks++;
    assert.equal(await tablePrivilege("anon", "products", "INSERT"), false, "anon no escribe catálogo"); checks++;
    assert.equal(await tablePrivilege("anon", "product_variants", "SELECT"), true, "anon lee variantes"); checks++;
    assert.equal(await tablePrivilege("anon", "product_media", "SELECT"), true, "anon lee media"); checks++;

    assert.equal(await tablePrivilege("authenticated", "orders", "SELECT"), true, "Admin conserva lectura de pedidos"); checks++;
    assert.equal(await tablePrivilege("authenticated", "order_items", "SELECT"), true, "Admin conserva lectura de ítems"); checks++;
    assert.equal(await tablePrivilege("authenticated", "payments", "SELECT"), true, "Admin conserva lectura de pagos"); checks++;
    for (const table of ["orders", "order_items", "payments"]) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
            assert.equal(await tablePrivilege("authenticated", table, privilege), false,
                `authenticated no tiene ${privilege} directo en ${table}`); checks++;
        }
    }

    const nonAdmin = "00000000-0000-0000-0000-000000000099";
    const owner = "00000000-0000-0000-0000-000000000001";
    const operator = "00000000-0000-0000-0000-000000000002";

    await runAs("authenticated", nonAdmin, async () => {
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.orders"), 0,
            "authenticated no-admin no ve pedidos"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.product_costs"), 0,
            "authenticated no-admin no ve costos pese al baseline"); checks++;
        assert.equal(await expectDenied(() => db.query(
            "INSERT INTO public.product_costs VALUES (2, 100)")), true,
            "authenticated no-admin no inserta costos"); checks++;
    });

    await runAs("authenticated", operator, async () => {
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.orders"), 1,
            "operador conserva lectura operativa de pedidos"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.order_items"), 1,
            "operador conserva lectura operativa de ítems"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.payments"), 1,
            "operador conserva lectura operativa de pagos"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.order_economics"), 1,
            "operador registrado conserva lectura de economía"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.order_variable_costs"), 1,
            "operador registrado conserva lectura de costos variables"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.product_costs"), 1,
            "operador registrado conserva lectura de costos de producto"); checks++;
        await db.query("INSERT INTO public.order_variable_costs VALUES (2, 100)");
        checks++;
        assert.equal(await expectDenied(() => db.query(
            "UPDATE public.orders SET status = 'paid' WHERE id = 1")), true,
            "operador no puede saltarse RPC con UPDATE directo"); checks++;
    });

    await runAs("authenticated", owner, async () => {
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.product_costs"), 1,
            "owner puede leer costos"); checks++;
        assert.equal(await rowCount("SELECT count(*)::int AS count FROM public.order_economics"), 1,
            "owner puede leer márgenes"); checks++;
        await db.query("INSERT INTO public.product_costs VALUES (2, 100)");
        checks++;
        assert.equal(await expectDenied(() => db.query(
            "DELETE FROM public.orders WHERE id = 1")), true,
            "owner también usa RPC/service role para mutaciones de pedidos"); checks++;
    });

    // Idempotencia de la nueva migración.
    await db.exec(hardeningMigration);
    assert.equal(await tablePrivilege("authenticated", "orders", "UPDATE"), false,
        "reaplicar conserva pedidos read-only"); checks++;
    assert.equal(await execPrivilege("authenticated", "public.is_admin()"), true,
        "la función de autorización existente sigue disponible para evaluar RLS"); checks++;

    console.log(`Security grants/RLS/orders: ${checks} checks OK`);
} finally {
    await db.close();
}
