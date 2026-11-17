import test from "node:test";
import assert from "node:assert/strict";

// `buildPublicPaymentUrl` lee Deno.env; en Node lo simulamos.
globalThis.Deno = {
    env: {
        get: (key) =>
            ({
                SUPABASE_URL: "https://demo.supabase.co",
            })[key],
    },
};

const { createOrder, buildWelcomeText, buildOrderStatusMessage, getOrderStatus, toolsDefinition } = await import("./tools.ts");

function makeSupabase(response, onRpc) {
    const calls = [];
    return {
        calls,
        client: {
            rpc: async (name, args) => {
                calls.push({ name, args });
                if (onRpc) return onRpc(name, args);
                return response;
            },
            from: () => {
                throw new Error("createOrder no debe insertar directamente en tablas");
            },
        },
    };
}

const items = [
    { product_id: "prod-a", size: 42, quantity: 1 },
    { product_id: "prod-b", size: 40, quantity: 2 },
];

const shipping = {
    shippingName: "Ana Pérez",
    shippingCity: "Bogotá",
    shippingAddress: "Calle 1 # 2-3",
};

const context = { conversationId: "conv-1", messageSid: "SM-1" };

const successPayload = {
    success: true,
    order_id: "order-1",
    payment_reference: "ORD-20261025120000-ABC123",
    total_cents: 200000,
    item_count: 2,
    quantity: 3,
    deduplicated: false,
};

test("createOrder llama la RPC atómica y no toca tablas", async () => {
    const { client, calls } = makeSupabase({ data: successPayload, error: null });

    const result = await createOrder(
        client,
        "cust-1",
        items,
        shipping.shippingCity,
        shipping.shippingAddress,
        shipping.shippingName,
        context,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "create_order_atomic");

    const args = calls[0].args;
    assert.equal(args.p_customer_id, "cust-1");
    assert.equal(args.p_shipping.city, "Bogotá");
    assert.equal(args.p_items.length, 2);
    assert.equal(args.p_items[0].quantity, 1);
    assert.match(args.p_idempotency_key, /^[0-9a-f]{64}$/);

    assert.equal(result.success, true);
    assert.equal(result.order_id, "order-1");
    assert.equal(result.total_cents, 200000);
    assert.match(result.message, /ORD-20261025120000-ABC123/);
    assert.match(result.message, /\$2\.000/);
});

test("dos intentos del mismo mensaje usan la misma clave", async () => {
    const { client, calls } = makeSupabase({ data: successPayload, error: null });

    await createOrder(
        client, "cust-1", items,
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        context,
    );
    await createOrder(
        client, "cust-1", items,
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        context,
    );

    assert.equal(calls.length, 2);
    assert.equal(
        calls[0].args.p_idempotency_key,
        calls[1].args.p_idempotency_key,
    );
});

test("un mensaje nuevo usa una clave distinta y la RPC decide si sigue activa la orden", async () => {
    const { client, calls } = makeSupabase({ data: successPayload, error: null });
    await createOrder(
        client, "cust-1", items,
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        context,
    );
    await createOrder(
        client, "cust-1", items,
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        { ...context, messageSid: "SM-2" },
    );
    assert.notEqual(calls[0].args.p_idempotency_key, calls[1].args.p_idempotency_key);
});

test("un pedido deduplicado lo comunica sin crear otro", async () => {
    const { client } = makeSupabase({
        data: {
            ...successPayload,
            deduplicated: true,
            duplicate_reason: "active_identical_order",
        },
        error: null,
    });

    const result = await createOrder(
        client, "cust-1", items,
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        context,
    );

    assert.equal(result.deduplicated, true);
    assert.match(result.message, /pedido idéntico activo/i);
    assert.match(result.message, /no se creó otro/i);
});

test("traduce errores de negocio de la RPC sin lanzar", async () => {
    const { client } = makeSupabase(null, () => ({
        data: null,
        error: { message: "INSUFFICIENT_STOCK: available 0" },
    }));

    const result = await createOrder(
        client, "cust-1", items,
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        context,
    );

    assert.match(result.error, /stock suficiente/i);
});

test("rechaza un pedido vacío antes de llamar la RPC", async () => {
    const { client, calls } = makeSupabase({ data: successPayload, error: null });

    const result = await createOrder(
        client, "cust-1", [],
        shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
        context,
    );

    assert.match(result.error, /inválido/i);
    assert.equal(calls.length, 0);
});

test("exige conversationId y messageSid para poder deduplicar", async () => {
    const { client } = makeSupabase({ data: successPayload, error: null });

    await assert.rejects(
        () =>
            createOrder(
                client, "cust-1", items,
                shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
                {},
            ),
        /conversationId|messageSid/,
    );
    await assert.rejects(
        () => createOrder(
            client, "cust-1", items,
            shipping.shippingCity, shipping.shippingAddress, shipping.shippingName,
            { conversationId: "conv-1", messageSid: " " },
        ),
        /messageSid/,
    );
});

// ---------------------------------------------------------------------------
// Saludo: solo se promete lo que se entrega
// ---------------------------------------------------------------------------

const base = { welcome_message: "Hola, bienvenido a SportBot." };

test("el saludo enlaza la tienda y no promete un PDF", () => {
    const text = buildWelcomeText({
        ...base,
        store_url: "https://sportbot.co",
        catalog_pdf: "https://sportbot.co/catalogo.pdf",
    });

    assert.match(text, /https:\/\/sportbot\.co/);
    assert.doesNotMatch(text, /catalogo\.pdf/);
});

test("sin tienda, el respaldo es el PDF como enlace real", () => {
    const text = buildWelcomeText({
        ...base,
        store_url: null,
        catalog_pdf: "https://sportbot.co/catalogo.pdf",
    });

    assert.match(text, /https:\/\/sportbot\.co\/catalogo\.pdf/);
});

test("sin tienda ni PDF no queda ninguna promesa vacía", () => {
    const text = buildWelcomeText({ ...base, store_url: null, catalog_pdf: null });

    assert.match(text, /Puedo mostrarte fotos/);
    assert.doesNotMatch(text, /te comparto/i);
    assert.doesNotMatch(text, /catálogo actualizado/i);
});

// ---------------------------------------------------------------------------
// Seguimiento del pedido: la herramienta existe y no inventa pasos
// ---------------------------------------------------------------------------

function statusSnapshot(overrides = {}) {
    return {
        order: {
            status: "paid",
            payment_reference: "ORD-20261026213646-7AA5CA",
            total_cents: 55000000,
            shipping_city: "Bogotá",
            ...overrides.order,
        },
        ship: overrides.ship ?? null,
        items: overrides.items ?? null,
    };
}

test("get_order_status está expuesta al modelo", () => {
    const names = toolsDefinition.map((tool) => tool.function.name);
    assert.ok(names.includes("get_order_status"));
});

test("pago pendiente: pide el comprobante y no promete envío", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({
        order: { status: "awaiting_payment" },
    }));

    assert.equal(reply.state, "awaiting_payment");
    assert.equal(reply.handoff_required, false);
    assert.match(reply.message, /ORD-20261026213646-7AA5CA/);
    assert.match(reply.message, /\$550\.000/);
    assert.match(reply.message, /comprobante/i);
    assert.doesNotMatch(reply.message, /transportadora|guía|va en camino/i);
});

test("pago confirmado sin guía: dice que está alistando", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({ order: { status: "paid" } }));

    assert.equal(reply.state, "preparing");
    assert.match(reply.message, /alistando/i);
    assert.doesNotMatch(reply.message, /Guía:/);
});

test("guía creada todavía no es 'en camino'", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({
        order: { status: "paid" },
        ship: {
            status: "label_created",
            carrier_name: "Servientrega",
            tracking_number: "ABC123",
        },
    }));

    assert.equal(reply.state, "label_created");
    assert.match(reply.message, /guía/i);
    assert.match(reply.message, /Aún no sale/i);
    assert.doesNotMatch(reply.message, /va en camino/i);
});

test("en tránsito entrega transportadora, guía y URL reales", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({
        order: { status: "shipped" },
        ship: {
            status: "in_transit",
            carrier_name: "Servientrega",
            tracking_number: "ABC123",
            tracking_url: "https://rastreo.servientrega.com/ABC123",
        },
    }));

    assert.equal(reply.state, "in_transit");
    assert.match(reply.message, /Servientrega/);
    assert.match(reply.message, /Guía: ABC123/);
    assert.match(reply.message, /https:\/\/rastreo\.servientrega\.com\/ABC123/);
});

test("sin datos de envío no inventa transportadora ni guía", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({
        order: { status: "shipped" },
        ship: { status: "shipped" },
    }));

    assert.equal(reply.state, "in_transit");
    assert.doesNotMatch(reply.message, /Transportadora:/);
    assert.doesNotMatch(reply.message, /Guía:/);
});

test("entregado usa la fecha real de entrega", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({
        order: { status: "delivered" },
        ship: { status: "delivered", delivered_at: "2026-10-24T15:00:00.000Z" },
    }));

    assert.equal(reply.state, "delivered");
    assert.match(reply.message, /entregado el 24 de octubre/i);
});

test("novedad de la transportadora escala a una persona", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({
        order: { status: "shipped" },
        ship: { status: "exception", carrier_name: "Servientrega", tracking_number: "ABC123" },
    }));

    assert.equal(reply.state, "exception");
    assert.equal(reply.handoff_required, true);
    assert.match(reply.message, /novedad/i);
    assert.match(reply.message, /una persona del equipo/i);
});

test("pedido cancelado no se reporta como entregado", () => {
    const reply = buildOrderStatusMessage(statusSnapshot({ order: { status: "cancelled" } }));

    assert.equal(reply.state, "cancelled");
    assert.equal(reply.handoff_required, true);
    assert.doesNotMatch(reply.message, /entregado/i);
});

// ---------------------------------------------------------------------------
// La consulta solo ve el pedido del cliente de esta conversación
// ---------------------------------------------------------------------------

function makeStatusClient({ orders = [], items = [], shipments = [], errors = {} } = {}) {
    const tables = { orders, order_items: items, shipments };
    const queries = [];

    return {
        queries,
        from(table) {
            const state = { table, filters: [], limit: null, sort: null };
            queries.push(state);

            const api = {
                select() { return api; },
                eq(column, value) { state.filters.push(["eq", column, value]); return api; },
                neq(column, value) { state.filters.push(["neq", column, value]); return api; },
                order(column, options) { state.sort = { column, options }; return api; },
                limit(value) { state.limit = value; return api; },
                then(resolve) {
                    let rows = [...(tables[table] || [])];

                    for (const [op, column, value] of state.filters) {
                        rows = op === "neq"
                            ? rows.filter((row) => row[column] !== value)
                            : rows.filter((row) => row[column] === value);
                    }

                    if (state.sort?.column === "created_at") {
                        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
                    }
                    if (state.limit != null) rows = rows.slice(0, state.limit);

                    resolve({ data: rows, error: errors[table] ?? null });
                },
            };

            return api;
        },
    };
}

const ginaOrder = {
    id: "11111111-1111-4111-8111-111111111111",
    customer_id: "cust-gina",
    status: "shipped",
    payment_reference: "ORD-20261026213646-7AA5CA",
    total_cents: 55000000,
    shipping_city: "Bogotá",
    created_at: "2026-10-26T21:36:46.000Z",
};

test("get_order_status acota la consulta al cliente y normaliza la referencia", async () => {
    const client = makeStatusClient({ orders: [ginaOrder] });

    const result = await getOrderStatus(client, "cust-gina", "ord-20261026213646-7aa5ca");

    assert.equal(result.found, true);
    assert.deepEqual(client.queries[0].filters, [
        ["eq", "customer_id", "cust-gina"],
        ["eq", "payment_reference", "ORD-20261026213646-7AA5CA"],
    ]);
});

test("una referencia de otro cliente no devuelve nada", async () => {
    const client = makeStatusClient({
        orders: [{ ...ginaOrder, customer_id: "cust-otro" }],
    });

    const result = await getOrderStatus(client, "cust-gina", "ORD-20261026213646-7AA5CA");

    assert.equal(result.found, false);
    assert.equal(result.state, "not_found");
    assert.doesNotMatch(result.message, /va en camino/i);
});

test("sin pedidos pide la referencia en vez de inventar un estado", async () => {
    const client = makeStatusClient({});

    const result = await getOrderStatus(client, "cust-gina", null);

    assert.equal(result.found, false);
    assert.match(result.message, /ORD-\*/);
});

test("toma el pedido más reciente que siga vivo", async () => {
    const client = makeStatusClient({
        orders: [
            { ...ginaOrder, id: "22222222-2222-4222-8222-222222222222", status: "awaiting_payment", created_at: "2026-10-27T10:00:00.000Z", payment_reference: "ORD-NEW" },
            ginaOrder,
        ],
        items: [{ order_id: ginaOrder.id, qty: 2, products: { brand: "Jordan", model: "1 Retro" } }],
        shipments: [{
            order_id: ginaOrder.id,
            shipment_number: 1,
            status: "in_transit",
            carrier_name: "Servientrega",
            tracking_number: "ABC123",
            tracking_url: "https://rastreo.servientrega.com/ABC123",
        }],
    });

    const result = await getOrderStatus(client, "cust-gina", null);

    assert.equal(result.found, true);
    assert.equal(result.reference, "ORD-NEW");
    assert.equal(result.state, "awaiting_payment");
    assert.equal(result.tracking_number, null);
});

test("ignora un envío cancelado y usa el activo", async () => {
    const client = makeStatusClient({
        orders: [ginaOrder],
        shipments: [
            { order_id: ginaOrder.id, shipment_number: 2, status: "cancelled" },
            { order_id: ginaOrder.id, shipment_number: 1, status: "shipped", carrier_name: "Envia", tracking_number: "ZZ9" },
        ],
    });

    const result = await getOrderStatus(client, "cust-gina", null);

    assert.equal(result.found, true);
    assert.equal(result.shipment_status, "shipped");
    assert.equal(result.tracking_number, "ZZ9");
});
