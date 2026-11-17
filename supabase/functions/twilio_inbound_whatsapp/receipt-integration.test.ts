import { capturePaymentReceipt } from "./payments.ts";
import { receiptCaptureReply } from "./receipt-capture-core.ts";

const order = { id: "order-1", customer_id: "customer-1", status: "awaiting_payment", payment_reference: "ORD-20261026213646-7AA5CA", total_cents: 45000000, payment_rejection_reason: null };
const media = { mediaFileId: "media-1", storagePath: "file.jpg", contentType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) };
const input = { customerId: "customer-1", conversationId: "conversation-1", messageId: "message-1", providerMessageId: "provider-1", caption: "", media: [media] };

function fakeDb(options: { order?: typeof order | null; orders?: (typeof order)[]; queryError?: boolean; insertError?: boolean; eventThrows?: boolean } = {}) {
    const writes: Record<string, unknown>[] = [];
    const filters: unknown[][] = [];
    const orderQuery = {
        select() { return this; },
        eq(...args: unknown[]) { filters.push(args); return this; },
        not() { return this; },
        async limit(count: number) {
            const rows = options.orders ?? (options.order === undefined ? [order] : options.order ? [options.order] : []);
            const filtered = rows.filter((row) => filters.every(([column, value]) => row[column as keyof typeof order] === value));
            return { data: filtered.slice(0, count), error: options.queryError ? { message: "query failed" } : null };
        },
    };
    const db = {
        from(table: string) {
            if (table === "orders") return orderQuery;
            if (table === "payment_receipts") return {
                insert(row: Record<string, unknown>) {
                    writes.push(row);
                    return { select: () => ({ single: async () => options.insertError
                        ? { data: null, error: { code: "OTHER", message: "insert failed" } }
                        : { data: { id: "receipt-1" }, error: null } }) };
                },
            };
            if (table === "conversation_events") return { insert: async () => {
                if (options.eventThrows) throw new Error("event failed");
                return { error: null };
            } };
            throw new Error(`Unexpected table ${table}`);
        },
    };
    return { db: db as any, writes, filters };
}

function expect(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

Deno.test("captura real guarda comprobante asociado al cliente y pedido", async () => {
    const { db, writes, filters } = fakeDb();
    const result = await capturePaymentReceipt(db, input);
    expect(result.kind === "captured", "debe registrar");
    expect(writes.length === 1 && writes[0].order_id === order.id && writes[0].customer_id === input.customerId, "asociación incorrecta");
    expect(filters.some(([column, value]) => column === "customer_id" && value === input.customerId), "consulta sin filtro por cliente");
    expect(!/pago aprobad/i.test(receiptCaptureReply(result)), "no debe aprobar pago");
});

Deno.test("captura real distingue ausencia de pedido y error de consulta", async () => {
    const absent = fakeDb({ order: null });
    const missing = await capturePaymentReceipt(absent.db, input);
    expect(missing.kind === "no_pending_order" && absent.writes.length === 0, "no debe insertar sin pedido");
    const failed = await capturePaymentReceipt(fakeDb({ queryError: true }).db, input);
    expect(failed.kind === "failed", "error de BD no es ausencia de pedido");
});

Deno.test("fallo de inserción no acusa y fallo de telemetría no pierde captura", async () => {
    const failed = await capturePaymentReceipt(fakeDb({ insertError: true }).db, input);
    expect(failed.kind === "failed", "fallo de inserción");
    const captured = await capturePaymentReceipt(fakeDb({ eventThrows: true }).db, input);
    expect(captured.kind === "captured", "telemetría no debe invalidar registro");
});

Deno.test("rutas de archivo duplicadas no se asocian a pedido", async () => {
    const { db, writes } = fakeDb();
    const result = await capturePaymentReceipt(db, { ...input, media: [media, { ...media, bytes: new Uint8Array([4]) }] });
    expect(result.kind === "failed" && writes.length === 0, "no debe registrar un archivo sobrescrito");
});

Deno.test("varios pedidos requieren referencia y permiten seleccionar el anterior", async () => {
    const newer = { ...order, id: "order-2", payment_reference: "ORD-20261026215040-7CCB8B" };
    const ambiguous = fakeDb({ orders: [newer, order] });
    const pending = await capturePaymentReceipt(ambiguous.db, input);
    expect(pending.kind === "reference_required" && ambiguous.writes.length === 0, "no debe elegir el más reciente");

    const chosen = fakeDb({ orders: [newer, order] });
    const captured = await capturePaymentReceipt(chosen.db, { ...input, caption: `Pago ${order.payment_reference.toLowerCase()}` });
    expect(captured.kind === "captured", "debe capturar con referencia válida");
    expect(chosen.writes[0]?.order_id === order.id, "debe asociar al pedido indicado, no al más reciente");
    expect(chosen.filters.some(([column, value]) => column === "payment_reference" && value === order.payment_reference), "falta filtro exacto de referencia");
});

Deno.test("referencias ajenas, inexistentes y pedidos pagados no se asocian", async () => {
    for (const row of [
        { ...order, customer_id: "another-customer" },
        { ...order, status: "paid" },
    ]) {
        const { db, writes } = fakeDb({ orders: [row] });
        const result = await capturePaymentReceipt(db, { ...input, caption: order.payment_reference });
        expect(result.kind === "reference_not_found" && writes.length === 0, "no debe asociar pedido ajeno o pagado");
    }
    const { db, writes } = fakeDb({ orders: [order] });
    const result = await capturePaymentReceipt(db, { ...input, caption: "ORD-20261026215040-7CCB8B" });
    expect(result.kind === "reference_not_found" && writes.length === 0, "no debe ignorar una referencia desconocida");
});

Deno.test("referencia parcial o varias referencias no se sustituyen por pedido único", async () => {
    for (const caption of ["ORD-20261026213646", `${order.payment_reference} y ORD-20261026215040-7CCB8B`]) {
        const { db, writes } = fakeDb({ orders: [order] });
        const result = await capturePaymentReceipt(db, { ...input, caption });
        expect(result.kind === "invalid_reference" && writes.length === 0, "referencia ambigua no debe crear comprobante");
    }
});
