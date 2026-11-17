#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261028193000_manual_payment_fee_quality.sql"), "utf8");
const db = new PGlite();
let checks = 0;

async function flags(order) {
    const result = await db.query("SELECT data_quality_flags, payment_fee_cents, contribution_margin_cents FROM public.order_economics WHERE order_id = $1", [order]);
    return result.rows[0];
}

try {
    await db.exec(`
        CREATE SCHEMA private;
        CREATE TABLE public.order_economics (
            order_id UUID PRIMARY KEY,
            data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            payment_fee_cents INTEGER NOT NULL DEFAULT 0,
            contribution_margin_cents INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE public.payments (
            order_id UUID NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL
        );
        INSERT INTO public.order_economics VALUES
            ('00000000-0000-0000-0000-000000000001', ARRAY['missing_payment_fee', 'missing_cogs'], 0, 12000),
            ('00000000-0000-0000-0000-000000000002', ARRAY['missing_payment_fee'], 0, 13000),
            ('00000000-0000-0000-0000-000000000003', ARRAY['missing_payment_fee'], 0, 14000);
        INSERT INTO public.payments VALUES
            ('00000000-0000-0000-0000-000000000001', 'manual', 'approved'),
            ('00000000-0000-0000-0000-000000000002', 'wompi', 'approved');
    `);
    await db.exec(migration);
    const manual = "00000000-0000-0000-0000-000000000001";
    const gateway = "00000000-0000-0000-0000-000000000002";
    const newlyPaid = "00000000-0000-0000-0000-000000000003";

    assert.deepEqual((await flags(manual)).data_quality_flags, ["missing_cogs"], "backfill clears only manual fee flag"); checks++;
    assert.deepEqual((await flags(gateway)).data_quality_flags, ["missing_payment_fee"], "gateway fee still needs review"); checks++;
    assert.deepEqual((await flags(newlyPaid)).data_quality_flags, ["missing_payment_fee"], "unconfirmed payment not suppressed"); checks++;

    await db.query("INSERT INTO public.payments VALUES ($1, 'manual', 'approved')", [newlyPaid]);
    assert.deepEqual((await flags(newlyPaid)).data_quality_flags, [], "approval clears flag in same transaction"); checks++;

    await db.query("UPDATE public.order_economics SET data_quality_flags = ARRAY['missing_payment_fee', 'missing_cogs'] WHERE order_id = $1", [manual]);
    assert.deepEqual((await flags(manual)).data_quality_flags, ["missing_cogs"], "later recalculations keep other quality warnings"); checks++;
    await db.query("UPDATE public.order_economics SET data_quality_flags = ARRAY['missing_payment_fee'] WHERE order_id = $1", [gateway]);
    assert.deepEqual((await flags(gateway)).data_quality_flags, ["missing_payment_fee"], "later gateway recalculation retains warning"); checks++;
    assert.equal((await flags(manual)).contribution_margin_cents, 12000, "economics unchanged"); checks++;

    await db.exec(migration);
    assert.deepEqual((await flags(manual)).data_quality_flags, ["missing_cogs"], "migration rerun is safe"); checks++;
    console.log(`P2 payment fee: ${checks} checks OK`);
} finally {
    await db.close();
}
