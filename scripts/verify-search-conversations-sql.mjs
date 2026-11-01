#!/usr/bin/env node
// SB-110: pruebas rigurosas de admin_search_conversations (busqueda server-side).
//
// Patrón idéntico a scripts/verify-human-messaging-sql.mjs (PGlite + assert).
//   * is_admin() se mockea a TRUE.
//   * auth.uid() se mockea como el operador actor (constante ACTOR).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261105120000_search_conversations.sql"), "utf8");
const db = new PGlite();

const ACTOR = "00000000-0000-4000-8000-000000000001";

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT '${ACTOR}'::uuid $$;
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
CREATE TABLE public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','operator'))
);
CREATE TABLE public.customers (
    id UUID PRIMARY KEY,
    name TEXT,
    phone_e164 TEXT
);
CREATE TABLE public.conversations (
    id UUID PRIMARY KEY,
    customer_id UUID REFERENCES public.customers(id),
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_message_at TIMESTAMPTZ
);
CREATE TABLE public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES public.conversations(id),
    direction TEXT NOT NULL,
    role TEXT NOT NULL,
    body TEXT,
    channel TEXT NOT NULL DEFAULT 'evolution',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES public.customers(id),
    status TEXT NOT NULL DEFAULT 'draft',
    payment_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id),
    tracking_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

await db.exec(schema);
await db.exec(migration);

// Datos base.
await db.query(`BEGIN`);
await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'actor@example.test')`, [ACTOR]);
await db.query(`INSERT INTO public.admin_users (user_id,email,role) VALUES ($1,'actor@example.test','operator')`, [ACTOR]);
await db.query(`COMMIT`);

let checks = 0;
async function check(name, run) {
    await db.query(`BEGIN`);
    try {
        await run();
        await db.query(`COMMIT`);
        checks++;
        console.log(`✓ ${name}`);
    } catch (err) {
        await db.query(`ROLLBACK`).catch(() => undefined);
        console.error(`✖ ${name}: ${err.message}`);
        throw err;
    }
}

async function insertCustomer(id, name, phone) {
    await db.query(`INSERT INTO public.customers (id,name,phone_e164) VALUES ($1,$2,$3)`, [id, name, phone]);
}
async function insertConversation(id, customerId, status = 'open', lastMessageAt = null) {
    if (lastMessageAt) {
        await db.query(`INSERT INTO public.conversations (id,customer_id,status,last_message_at) VALUES ($1,$2,$3,$4)`, [id, customerId, status, lastMessageAt]);
    } else {
        await db.query(`INSERT INTO public.conversations (id,customer_id,status) VALUES ($1,$2,$3)`, [id, customerId, status]);
    }
}
async function insertMessage(conversationId, body, direction = 'inbound', role = 'user', minutesAgo = 0) {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    await db.query(`INSERT INTO public.messages (conversation_id,direction,role,body,created_at) VALUES ($1,$2,$3,$4,$5)`, [conversationId, direction, role, body, createdAt]);
}
async function insertOrder(id, customerId, paymentReference, status = 'paid') {
    await db.query(`INSERT INTO public.orders (id,customer_id,payment_reference,status) VALUES ($1,$2,$3,$4)`, [id, customerId, paymentReference, status]);
}
async function insertShipment(orderId, trackingNumber) {
    await db.query(`INSERT INTO public.shipments (order_id,tracking_number) VALUES ($1,$2)`, [orderId, trackingNumber]);
}

// Customer c1: Juan Perez, +12025550101
const cust1 = "00000000-0000-4000-8000-000000000111";
// Customer c2: Maria Gomez, +12025550104
const cust2 = "00000000-0000-4000-8000-000000000222";
// Conversation conv1: customer c1, mensaje "Nike Pegasus talla 42"
const conv1 = "00000000-0000-4000-8000-000000000333";
// Conversation conv2: customer c2, mensaje "Adidas Ultraboost"
const conv2 = "00000000-0000-4000-8000-000000000444";
// Order ord1 para c1, referencia ORD-12345
const ord1 = "00000000-0000-4000-8000-000000000555";
// Shipment para ord1, guia GUIA-999
const sh1 = "00000000-0000-4000-8000-000000000666";

await db.query(`BEGIN`);
await insertCustomer(cust1, 'Juan Perez', '+12025550101');
await insertCustomer(cust2, 'Maria Gomez', '+12025550104');
await insertConversation(conv1, cust1, 'open');
await insertConversation(conv2, cust2, 'closed');
await insertMessage(conv1, 'Nike Pegasus talla 42, ¿tienen?', 'inbound', 'user', 30);
await insertMessage(conv1, 'Sí tenemos Nike Pegasus 42', 'outbound', 'agent', 25);
await insertMessage(conv2, 'Adidas Ultraboost blanca', 'inbound', 'user', 20);
await insertOrder(ord1, cust1, 'ORD-12345', 'paid');
await insertShipment(ord1, 'GUIA-999');
await db.query(`COMMIT`);

// Busca por telefono: encuentra conv1 (cliente c1).
await check("busca por telefono de cliente", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['+12025550101', 20, 0]);
    const ids = rows.map((r) => r.conversation_id);
    assert.ok(ids.includes(conv1), `conversacion ${conv1} debe aparecer al buscar telefono`);
    assert.equal(rows.find((r) => r.conversation_id === conv1)?.match_type, 'customer');
});

// Busca por nombre de cliente: encuentra conv1.
await check("busca por nombre de cliente", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['juan perez', 20, 0]);
    const ids = rows.map((r) => r.conversation_id);
    assert.ok(ids.includes(conv1), `conversacion ${conv1} debe aparecer al buscar nombre`);
});

// Busca por cuerpo de mensaje: encuentra conv1 (Nike Pegasus).
await check("busca por cuerpo de mensaje", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['pegasus', 20, 0]);
    const ids = rows.map((r) => r.conversation_id);
    assert.ok(ids.includes(conv1), `conversacion ${conv1} debe aparecer al buscar mensaje`);
    assert.equal(rows.find((r) => r.conversation_id === conv1)?.match_type, 'message');
});

// Busca por referencia de orden: encuentra conv1 (ORD-12345).
await check("busca por referencia de orden", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['ORD-12345', 20, 0]);
    const ids = rows.map((r) => r.conversation_id);
    assert.ok(ids.includes(conv1), `conversacion ${conv1} debe aparecer al buscar orden`);
    assert.equal(rows.find((r) => r.conversation_id === conv1)?.match_type, 'order');
});

// Busca por numero de guia: encuentra conv1 (GUIA-999).
await check("busca por numero de guia", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['GUIA-999', 20, 0]);
    const ids = rows.map((r) => r.conversation_id);
    assert.ok(ids.includes(conv1), `conversacion ${conv1} debe aparecer al buscar guia`);
    assert.equal(rows.find((r) => r.conversation_id === conv1)?.match_type, 'shipment');
});

// Busca por termo que no coincide: devuelve vacio.
await check("busca sin resultados devuelve vacio", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['zzznoresultado', 20, 0]);
    assert.equal(rows.length, 0, 'busqueda sin coincidencias debe devolver 0 filas');
});

// Paginacion: limit 1 devuelve 1 fila.
await check("paginacion limit 1", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['57300', 1, 0]);
    assert.equal(rows.length, 1, 'limit 1 debe devolver exactamente 1 fila');
});

// Offset salta filas.
await check("paginacion offset", async () => {
    const { rows: all } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['57300', 20, 0]);
    const { rows: offset1 } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['57300', 20, 1]);
    if (all.length > 1) {
        assert.equal(offset1.length, all.length - 1, 'offset 1 debe devolver una fila menos');
    } else {
        assert.equal(offset1.length, 0, 'offset 1 sobre un solo resultado devuelve 0');
    }
});

// Busca como admin (is_admin() mockeado a TRUE): debe tener éxito.
await check("busca como administrador", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_search_conversations($1,$2,$3)`, ['57300', 20, 0]);
    assert.ok(Array.isArray(rows), 'busqueda como admin debe devolver filas');
});

// Privilegios de ejecucion.
await check("privilegios de ejecucion de RPC de busqueda", async () => {
    const perms = await db.query(`
        SELECT
          has_function_privilege('authenticated','public.admin_search_conversations(text,integer,integer)','EXECUTE') AS auth_exec,
          has_function_privilege('anon','public.admin_search_conversations(text,integer,integer)','EXECUTE') AS anon_exec
    `);
    assert.deepEqual(perms.rows[0], {
        auth_exec: true, anon_exec: false,
    });
});

await db.close();
console.log(`\n${checks} search-conversations SQL checks passed.`);
