/**
 * Database-backed tools for the Agent Proxy.
 *
 * Read-only except `create_agent_action`, which only inserts a proposal.
 * The service-role client is injected; no secrets or raw tables are exposed
 * to the model beyond these summarized shapes.
 */

import type { ToolExecutor } from "./agent-mcp-core.ts";

type AnyClient = any;

const ACTIVE_SHIPMENT_STATUSES = ["shipped", "in_transit", "out_for_delivery", "delivered"];
const OPEN_ACTION_STATUSES = ["suggested", "pending_approval", "approved"];

function hoursSince(value: string | null | undefined, now = Date.now()): number {
    if (!value) return 0;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 0;
    return Math.max(0, Math.round(((now - timestamp) / 3_600_000) * 10) / 10);
}

function maskPhone(phone: string | null | undefined): string | null {
    const clean = String(phone ?? "").replace(/[^\d]/g, "");
    if (!clean) return null;
    return `***${clean.slice(-4)}`;
}

function bogotaDayStart(now = new Date()): Date {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
    const month = Number(parts.find((part) => part.type === "month")?.value ?? "01");
    const day = Number(parts.find((part) => part.type === "day")?.value ?? "01");
    // Colombia is UTC-05:00 year-round (no DST).
    return new Date(Date.UTC(year, month - 1, day, 5, 0, 0));
}

function sumCents(rows: Array<{ total_cents?: number | null }> | null | undefined): number {
    return (rows ?? []).reduce((total, row) => total + (Number(row.total_cents) || 0), 0);
}

function cleanError(value: unknown, max = 240): string | null {
    if (!value) return null;
    return String(value).replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function receiptAmountCents(extracted: unknown): number | null {
    if (!extracted || typeof extracted !== "object") return null;
    const cop = Number((extracted as Record<string, unknown>).amount_cop);
    return Number.isFinite(cop) ? cop * 100 : null;
}

async function must(query: any, label: string): Promise<any> {
    const { data, error } = await query;
    if (error) {
        const message = error && typeof error === "object" && "message" in error
            ? String((error as { message?: unknown }).message)
            : "database error";
        throw new Error(`${label}: ${message}`);
    }
    return data;
}

async function countRows(query: any, label: string): Promise<number> {
    const { count, error } = await query;
    if (error) {
        const message = error && typeof error === "object" && "message" in error
            ? String((error as { message?: unknown }).message)
            : "database error";
        throw new Error(`${label}: ${message}`);
    }
    return Number(count ?? 0);
}

export function createAgentToolExecutor(
    supabase: AnyClient,
    options: { adminBaseUrl: string },
): ToolExecutor {
    const adminUrl = (path: string) => `${options.adminBaseUrl.replace(/\/$/, "")}${path}`;

    async function getOperationsBrief() {
        const start = bogotaDayStart();
        const startIso = start.toISOString();

        const [ordersToday, paidToday, awaiting, paidOrders, variants, openActions] = await Promise.all([
            countRows(supabase.from("orders").select("id", { count: "exact", head: true }).gte("created_at", startIso), "orders today"),
            must(supabase.from("orders").select("total_cents").in("status", ["paid", "shipped", "delivered"]).gte("paid_at", startIso), "revenue today"),
            countRows(supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "awaiting_payment"), "awaiting payment"),
            must(supabase.from("orders").select("id, paid_at, shipments(status)").eq("status", "paid"), "paid orders"),
            must(supabase.from("product_variants").select("id, stock, reserved, products!inner(active)").eq("products.active", true), "inventory"),
            countRows(supabase.from("agent_actions").select("id", { count: "exact", head: true }).in("status", OPEN_ACTION_STATUSES), "open actions"),
        ]);

        const pendingDispatch = (paidOrders ?? []).filter((order: any) =>
            !(order.shipments ?? []).some((shipment: any) => ACTIVE_SHIPMENT_STATUSES.includes(shipment.status))
        );
        const currentCutoff = Date.now() - 30 * 24 * 3_600_000;
        const currentDispatch = pendingDispatch.filter((order: any) =>
            Boolean(order.paid_at) && Date.parse(order.paid_at) >= currentCutoff
        );
        const legacyDispatch = pendingDispatch.filter((order: any) =>
            !order.paid_at || Date.parse(order.paid_at) < currentCutoff
        );
        const overSla = currentDispatch.filter((order: any) =>
            Boolean(order.paid_at) && hoursSince(order.paid_at) >= 24
        );

        const awaitingIds = (await must(
            supabase.from("orders").select("id").eq("status", "awaiting_payment").limit(500),
            "awaiting ids",
        ) ?? []).map((row: any) => row.id);
        const receipts = awaitingIds.length
            ? await must(supabase.from("payment_receipts").select("order_id, status").in("order_id", awaitingIds).neq("status", "rejected"), "pending receipts")
            : [];
        const receiptsPending = new Set((receipts ?? []).map((row: any) => row.order_id)).size;

        const lowStock = (variants ?? []).filter((variant: any) =>
            Number(variant.stock ?? 0) - Number(variant.reserved ?? 0) < 3
        ).length;

        return {
            generated_at: new Date().toISOString(),
            timezone: "America/Bogota",
            today: {
                orders_created: ordersToday,
                paid_orders: (paidToday ?? []).length,
                revenue_cents: sumCents(paidToday),
            },
            payments: {
                awaiting_count: awaiting,
                receipts_pending_count: receiptsPending,
            },
            logistics: {
                paid_pending_dispatch_count: currentDispatch.length,
                paid_over_sla_count: overSla.length,
                legacy_paid_pending_count: legacyDispatch.length,
                window_days: 30,
            },
            inventory: { low_stock_variants_count: lowStock },
            ai_ops: { open_actions_count: openActions },
            links: {
                dashboard: adminUrl("/"),
                payments: adminUrl("/payments"),
                logistics: adminUrl("/logistics"),
                ai_ops: adminUrl("/ai-ops"),
            },
        };
    }

    async function listPaymentQueue(args: Record<string, unknown>) {
        const limit = Number(args.limit ?? 10);
        const orders = await must(
            supabase
                .from("orders")
                .select("id, payment_reference, total_cents, created_at, paid_at, payment_rejected_at, payment_rejection_reason, shipping_city, customers(name, phone_e164)")
                .eq("status", "awaiting_payment")
                .order("created_at", { ascending: true })
                .limit(limit),
            "payment queue",
        );

        const ids = (orders ?? []).map((order: any) => order.id);
        const [receipts, decisions] = await Promise.all([
            ids.length
                ? must(supabase.from("payment_receipts").select("id, order_id, status, ai_verdict, ai_extracted, created_at").in("order_id", ids).order("created_at", { ascending: false }), "receipts")
                : [],
            ids.length
                ? must(supabase.from("payment_decisions").select("id, order_id, decision, amount_cents, note, created_at").in("order_id", ids).order("created_at", { ascending: false }), "decisions")
                : [],
        ]);

        const latestReceipt = new Map<string, any>();
        for (const receipt of receipts ?? []) {
            if (!latestReceipt.has(receipt.order_id)) latestReceipt.set(receipt.order_id, receipt);
        }
        const latestDecision = new Map<string, any>();
        for (const decision of decisions ?? []) {
            if (!latestDecision.has(decision.order_id)) latestDecision.set(decision.order_id, decision);
        }

        return {
            generated_at: new Date().toISOString(),
            count: (orders ?? []).length,
            items: (orders ?? []).map((order: any) => {
                const receipt = latestReceipt.get(order.id);
                const decision = latestDecision.get(order.id);
                const extracted = receipt?.ai_extracted && typeof receipt.ai_extracted === "object"
                    ? receipt.ai_extracted as Record<string, unknown>
                    : {};
                return {
                    order_id: order.id,
                    payment_reference: order.payment_reference,
                    status: "awaiting_payment",
                    total_cents: order.total_cents,
                    hours_waiting: hoursSince(order.created_at),
                    customer: {
                        name: order.customers?.name ?? null,
                        phone_masked: maskPhone(order.customers?.phone_e164),
                    },
                    shipping_city: order.shipping_city,
                    last_rejection: order.payment_rejected_at
                        ? { at: order.payment_rejected_at, reason: order.payment_rejection_reason }
                        : null,
                    receipt: receipt
                        ? {
                            status: receipt.status,
                            ai_verdict: receipt.ai_verdict,
                            amount_cents: receiptAmountCents(extracted),
                            created_at: receipt.created_at,
                        }
                        : null,
                    last_decision: decision
                        ? {
                            decision: decision.decision,
                            amount_cents: decision.amount_cents,
                            note: decision.note,
                            created_at: decision.created_at,
                        }
                        : null,
                    admin_url: adminUrl("/payments"),
                };
            }),
        };
    }

    async function getOrder(args: Record<string, unknown>) {
        const base = supabase
            .from("orders")
            .select("id, payment_reference, status, total_cents, subtotal_cents, created_at, paid_at, payment_rejected_at, payment_rejection_reason, shipping_city, customers(name, phone_e164)")
            .limit(1);
        const filtered = args.order_id
            ? base.eq("id", args.order_id)
            : base.eq("payment_reference", args.payment_reference);
        const order = await must(filtered.maybeSingle(), "order");

        if (!order) throw new Error("Pedido no encontrado");

        const [items, shipment, receipts, decisions] = await Promise.all([
            must(supabase.from("order_items").select("product_id, variant_id, qty, unit_price_cents").eq("order_id", order.id), "items"),
            must(supabase.from("shipments").select("status, carrier_name, tracking_number, tracking_url, shipped_at, delivered_at, created_at").eq("order_id", order.id).order("created_at", { ascending: false }).limit(1), "shipment"),
            must(supabase.from("payment_receipts").select("status, ai_verdict, ai_extracted, created_at").eq("order_id", order.id).order("created_at", { ascending: false }).limit(3), "receipts"),
            must(supabase.from("payment_decisions").select("decision, amount_cents, note, created_at").eq("order_id", order.id).order("created_at", { ascending: false }).limit(3), "decisions"),
        ]);

        const productIds = [...new Set((items ?? []).map((item: any) => item.product_id).filter(Boolean))];
        const variantIds = [...new Set((items ?? []).map((item: any) => item.variant_id).filter(Boolean))];
        const [products, variants] = await Promise.all([
            productIds.length ? must(supabase.from("products").select("id, brand, model").in("id", productIds), "products") : [],
            variantIds.length ? must(supabase.from("product_variants").select("id, size").in("id", variantIds), "variants") : [],
        ]);
        const productById = new Map<string, any>((products ?? []).map((product: any) => [product.id, product]));
        const variantById = new Map<string, any>((variants ?? []).map((variant: any) => [variant.id, variant]));

        return {
            order_id: order.id,
            payment_reference: order.payment_reference,
            status: order.status,
            total_cents: order.total_cents,
            subtotal_cents: order.subtotal_cents,
            customer: {
                name: order.customers?.name ?? null,
                phone_masked: maskPhone(order.customers?.phone_e164),
            },
            shipping_city: order.shipping_city,
            created_at: order.created_at,
            paid_at: order.paid_at,
            last_rejection: order.payment_rejected_at
                ? { at: order.payment_rejected_at, reason: order.payment_rejection_reason }
                : null,
            items: (items ?? []).map((item: any) => {
                const product = productById.get(item.product_id);
                const variant = variantById.get(item.variant_id);
                return {
                    product: product ? [product.brand, product.model].filter(Boolean).join(" ") : null,
                    size: variant?.size ?? null,
                    qty: item.qty,
                    unit_price_cents: item.unit_price_cents,
                };
            }),
            shipment: (shipment ?? [])[0] ?? null,
            receipts: (receipts ?? []).map((receipt: any) => {
                const extracted = receipt.ai_extracted && typeof receipt.ai_extracted === "object"
                    ? receipt.ai_extracted as Record<string, unknown>
                    : {};
                return {
                    status: receipt.status,
                    ai_verdict: receipt.ai_verdict,
                    amount_cents: receiptAmountCents(extracted),
                    created_at: receipt.created_at,
                };
            }),
            decisions: decisions ?? [],
            admin_url: adminUrl("/orders"),
        };
    }

    async function listInventoryAlerts(args: Record<string, unknown>) {
        const limit = Number(args.limit ?? 10);
        const variants = await must(
            supabase
                .from("product_variants")
                .select("id, size, stock, reserved, products!inner(brand, model, active)")
                .eq("products.active", true)
                .limit(200),
            "inventory",
        );

        const items = (variants ?? [])
            .map((variant: any) => ({
                variant_id: variant.id,
                product: [variant.products?.brand, variant.products?.model].filter(Boolean).join(" "),
                size: variant.size,
                stock: Number(variant.stock ?? 0),
                reserved: Number(variant.reserved ?? 0),
                available: Number(variant.stock ?? 0) - Number(variant.reserved ?? 0),
            }))
            .filter((item: any) => item.available < 3)
            .sort((a: any, b: any) => a.available - b.available)
            .slice(0, limit);

        return { generated_at: new Date().toISOString(), count: items.length, items };
    }

    async function listLogisticsQueue(args: Record<string, unknown>) {
        const limit = Number(args.limit ?? 10);
        const paidOrders = await must(
            supabase
                .from("orders")
                .select("id, payment_reference, total_cents, paid_at, shipping_city, customers(name), shipments(status)")
                .eq("status", "paid")
                .order("paid_at", { ascending: true })
                .limit(100),
            "paid orders",
        );

        const pendingOrders = (paidOrders ?? []).filter((order: any) =>
            !(order.shipments ?? []).some((shipment: any) => ACTIVE_SHIPMENT_STATUSES.includes(shipment.status))
        );
        const cutoff = Date.now() - 30 * 24 * 3_600_000;
        const currentPending = pendingOrders.filter((order: any) =>
            Boolean(order.paid_at) && Date.parse(order.paid_at) >= cutoff
        );
        const legacyPendingCount = pendingOrders.length - currentPending.length;

        const paidToDispatch = currentPending
            .map((order: any) => ({
                order_id: order.id,
                payment_reference: order.payment_reference,
                customer_name: order.customers?.name ?? null,
                shipping_city: order.shipping_city,
                total_cents: order.total_cents,
                paid_at: order.paid_at,
                hours_waiting: hoursSince(order.paid_at),
                over_sla: hoursSince(order.paid_at) >= 24,
            }))
            .slice(0, limit);

        const activeShipments = await must(
            supabase
                .from("shipments")
                .select("id, order_id, status, carrier_name, tracking_number, shipped_at")
                .in("status", ["shipped", "in_transit", "out_for_delivery"])
                .limit(100),
            "active shipments",
        );
        const missingTracking = (activeShipments ?? [])
            .filter((shipment: any) => !String(shipment.tracking_number ?? "").trim())
            .map((shipment: any) => ({
                shipment_id: shipment.id,
                order_id: shipment.order_id,
                status: shipment.status,
                carrier_name: shipment.carrier_name,
                shipped_at: shipment.shipped_at,
                hours_in_transit: hoursSince(shipment.shipped_at),
            }))
            .slice(0, limit);

        const failed = await must(
            supabase
                .from("logistics_notifications")
                .select("id, order_id, purpose, status, error_message, created_at")
                .in("status", ["failed", "undelivered"])
                .order("created_at", { ascending: false })
                .limit(10),
            "failed notifications",
        );

        return {
            generated_at: new Date().toISOString(),
            window_days: 30,
            paid_to_dispatch: paidToDispatch,
            legacy_paid_without_shipment_count: legacyPendingCount,
            missing_tracking: missingTracking,
            failed_notifications: (failed ?? []).map((notification: any) => ({
                notification_id: notification.id,
                order_id: notification.order_id,
                purpose: notification.purpose,
                status: notification.status,
                error: cleanError(notification.error_message),
                created_at: notification.created_at,
            })),
            admin_url: adminUrl("/logistics"),
        };
    }

    async function createAgentAction(args: Record<string, unknown>) {
        const actionType = String(args.action_type);
        const targetType = args.target_type === undefined ? null : String(args.target_type);
        const targetId = args.target_id === undefined ? null : String(args.target_id);
        const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

        let existingQuery = supabase
            .from("agent_actions")
            .select("id, status, created_at, expires_at")
            .eq("action_type", actionType)
            .in("status", OPEN_ACTION_STATUSES)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(1);
        existingQuery = targetType ? existingQuery.eq("target_type", targetType) : existingQuery.is("target_type", null);
        existingQuery = targetId ? existingQuery.eq("target_id", targetId) : existingQuery.is("target_id", null);

        const existing = await must(existingQuery, "dedupe proposal");
        if (existing && existing.length > 0) {
            return {
                action_id: existing[0].id,
                status: existing[0].status,
                deduplicated: true,
                message: "Ya existe una propuesta abierta para el mismo tipo y objetivo en las últimas 24 h.",
                admin_url: adminUrl("/ai-ops"),
            };
        }

        const hours = Number(args.expires_in_hours ?? 24);
        const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
        const proposedPayload = {
            ...(args.proposed_payload && typeof args.proposed_payload === "object" ? args.proposed_payload : {}),
            review_surface: "/ai-ops",
        };

        const inserted = await must(
            supabase
                .from("agent_actions")
                .insert({
                    agent_name: "openclaw",
                    channel: "agent_proxy",
                    role_scope: "system",
                    created_by_user_id: null,
                    action_type: actionType,
                    target_type: targetType,
                    target_id: targetId,
                    target_ref: args.target_ref === undefined ? null : String(args.target_ref),
                    status: "pending_approval",
                    risk_level: String(args.risk_level),
                    summary: String(args.summary),
                    evidence: Array.isArray(args.evidence) ? args.evidence : [],
                    input_context: {
                        source: "agent_mcp",
                        mode: "suggest_only",
                        requested_by: "agent_runtime",
                        tool: "create_agent_action",
                        generated_at: new Date().toISOString(),
                    },
                    proposed_payload: proposedPayload,
                    approval_required: true,
                    expires_at: expiresAt,
                })
                .select("id, status, created_at, expires_at")
                .single(),
            "insert proposal",
        );

        return {
            action_id: inserted.id,
            status: inserted.status,
            expires_at: inserted.expires_at,
            deduplicated: false,
            message: "Propuesta creada. No se ejecutó nada; un humano debe aprobarla en /ai-ops.",
            admin_url: adminUrl("/ai-ops"),
        };
    }

    return async (name, args) => {
        switch (name) {
            case "get_operations_brief":
                return await getOperationsBrief();
            case "list_payment_queue":
                return await listPaymentQueue(args);
            case "get_order":
                return await getOrder(args);
            case "list_inventory_alerts":
                return await listInventoryAlerts(args);
            case "list_logistics_queue":
                return await listLogisticsQueue(args);
            case "create_agent_action":
                return await createAgentAction(args);
            default:
                throw new Error(`Herramienta desconocida: ${name}`);
        }
    };
}

export async function recordToolCall(
    supabase: AnyClient,
    input: {
        toolName: string;
        args: Record<string, unknown>;
        status: "ok" | "error" | "denied";
        error?: string | null;
        latencyMs?: number | null;
    },
): Promise<void> {
    try {
        await supabase.from("agent_tool_calls").insert({
            tool_name: input.toolName.slice(0, 120),
            arguments: input.args ?? {},
            status: input.status,
            error_message: cleanError(input.error, 500),
            latency_ms: input.latencyMs ?? null,
            actor: "agent_proxy",
        });
    } catch (error) {
        console.warn("[agent_mcp] audit insert failed", error instanceof Error ? error.message : error);
    }
}

export async function assertRateLimit(supabase: AnyClient, maxPerMinute = 60): Promise<void> {
    const since = new Date(Date.now() - 60_000).toISOString();
    const result = await supabase
        .from("agent_tool_calls")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since);
    if (result.error) return; // fail open on audit read failure; auth is still enforced
    const count = Number(result.count ?? 0);
    if (count >= maxPerMinute) throw new Error("Rate limit: demasiadas llamadas por minuto");
}
