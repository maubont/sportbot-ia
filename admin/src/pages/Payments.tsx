import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
    AlertTriangle,
    BadgeCheck,
    Banknote,
    Check,
    ExternalLink,
    FileText,
    RefreshCw,
    ShieldCheck,
    X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

type ReceiptStatus = "received" | "prevalidated" | "approved" | "rejected" | "superseded";
type AiVerdict = "match" | "mismatch" | "uncertain" | "not_run" | null;

type Receipt = {
    id: string;
    status: ReceiptStatus;
    ai_verdict: AiVerdict;
    ai_confidence: number | null;
    ai_extracted: Record<string, unknown>;
    ai_evidence: Array<{ kind?: string; detail?: string; source?: string }>;
    ai_checked_at: string | null;
    storage_bucket: string;
    storage_path: string;
    content_type: string | null;
    created_at: string;
    review_note: string | null;
};

type QueueOrder = {
    order_id: string;
    payment_reference: string;
    total_cents: number;
    status: string;
    payment_method: string;
    created_at: string;
    waiting_hours: number;
    rejection_reason: string | null;
    rejected_at: string | null;
    payment_received_cents: number | null;
    payment_shortfall_cents: number | null;
    payment_shortfall_at: string | null;
    customer: {
        id: string | null;
        name: string | null;
        phone: string | null;
    };
    items: Array<{
        product: string;
        size: string | null;
        qty: number;
        unit_price_cents: number;
    }>;
    receipts: Receipt[];
};

type QueueResponse = {
    generated_at: string;
    payment_config_complete: boolean;
    orders: QueueOrder[];
};

type Decision = {
    id: string;
    order_id: string;
    decision: "approved" | "rejected";
    payment_reference: string;
    amount_cents: number;
    actor_email: string | null;
    note: string | null;
    created_at: string;
};

const VERDICT_LABELS: Record<string, { label: string; className: string }> = {
    match: { label: "Datos coinciden", className: "bg-emerald-100 text-emerald-800" },
    mismatch: { label: "No coincide", className: "bg-red-100 text-red-700" },
    uncertain: { label: "Revisar a mano", className: "bg-amber-100 text-amber-800" },
    not_run: { label: "Sin lectura automática", className: "bg-slate-100 text-slate-600" },
};

function formatCents(cents?: number | null) {
    return `$${((cents || 0) / 100).toLocaleString("es-CO")}`;
}

function formatWaiting(hours: number) {
    if (hours < 1) return "menos de 1h";
    if (hours < 48) return `${Math.floor(hours)}h`;
    return `${Math.floor(hours / 24)}d`;
}

function readableRpcError(message: string) {
    if (message.includes("RECEIPT_REQUIRED")) {
        return "Este pedido no tiene comprobante por revisar. Pídeselo al cliente antes de aprobar.";
    }
    if (message.includes("REFERENCE_MISMATCH")) {
        return "La referencia cambió. Refresca la cola antes de aprobar.";
    }
    if (message.includes("AMOUNT_MISMATCH")) {
        return "El monto no coincide con el pedido. No se aprobó nada.";
    }
    if (message.includes("RECEIPT_NOT_FOUND")) {
        return "Ese comprobante ya fue revisado o no pertenece al pedido. Refresca la cola.";
    }
    if (message.includes("PAYMENT_ALREADY_APPROVED")) {
        return "Ese pago ya fue aprobado; no se puede rechazar.";
    }
    if (message.includes("PAYMENT_REFERENCE_CONFLICT")) {
        return "Esa referencia ya está aprobada en otro pedido. Revisa a mano.";
    }
    if (message.includes("NOT_ADMIN")) {
        return "Tu usuario no es administrador.";
    }
    if (message.includes("REASON_REQUIRED")) {
        return "Escribe un motivo de al menos 5 caracteres para el cliente.";
    }
    if (message.includes("ORDER_NOT_PAYABLE") || message.includes("ORDER_NOT_REVIEWABLE")) {
        return "El pedido cambió de estado. Refresca la cola.";
    }
    return message;
}

export default function Payments() {
    const [queue, setQueue] = useState<QueueResponse | null>(null);
    const [decisions, setDecisions] = useState<Decision[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
    const [bankConfirmed, setBankConfirmed] = useState<Record<string, boolean>>({});
    const [approvalNote, setApprovalNote] = useState<Record<string, string>>({});
    const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
    const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

    useEffect(() => {
        void fetchQueue();
    }, []);

    async function fetchQueue() {
        setLoading(true);
        setError(null);
        setWarning(null);

        const { data, error } = await supabase.rpc("admin_payment_queue", { p_limit: 60 });

        setLoading(false);

        if (error) {
            setError(error.message);
            return;
        }

        const parsed = data as QueueResponse | null;
        setQueue(parsed);

        // La auditoria es de solo lectura para admins: sin ella no hay visibilidad de la decision.
        const { data: recent, error: decisionsError } = await supabase
            .from("payment_decisions")
            .select("id, order_id, decision, payment_reference, amount_cents, actor_email, note, created_at")
            .order("created_at", { ascending: false })
            .limit(8);

        if (decisionsError) {
            console.warn("[payments] no se pudo leer la auditoria de decisiones:", decisionsError.message);
            setDecisions([]);
        } else {
            setDecisions((recent ?? []) as Decision[]);
        }

        // Los comprobantes son privados: se firma cada uno por 10 minutos.
        const receipts = (parsed?.orders ?? []).flatMap((order) => order.receipts);

        if (receipts.length > 0) {
            const entries = await Promise.all(
                receipts.map(async (receipt) => {
                    const { data: signed } = await supabase.storage
                        .from(receipt.storage_bucket || "whatsapp-media")
                        .createSignedUrl(receipt.storage_path, 600);

                    return [receipt.id, signed?.signedUrl ?? ""] as const;
                }),
            );

            setSignedUrls(Object.fromEntries(entries.filter(([, url]) => Boolean(url))));
        }
    }

    const stats = useMemo(() => {
        const orders = queue?.orders ?? [];
        return {
            pending: orders.length,
            withReceipt: orders.filter((order) => order.receipts.some(isReviewable)).length,
            withoutReceipt: orders.filter((order) => !order.receipts.some(isReviewable)).length,
            flagged: orders.filter((order) =>
                order.receipts.some((receipt) => isReviewable(receipt) && receipt.ai_verdict === "mismatch")
            ).length,
        };
    }, [queue]);

    async function notifyDecision(order: QueueOrder) {
        try {
            const { data, error } = await supabase.functions.invoke("payment_decision_notify", {
                body: { order_id: order.order_id },
            });

            if (error) throw error;

            if (data?.success === false && data?.skipped) {
                return `La decisión quedó guardada, pero no se envió el aviso (${data.skipped}). Escríbele al cliente desde el Inbox.`;
            }

            if (data?.success === false) {
                return `La decisión quedó guardada, pero el aviso por WhatsApp falló: ${data?.error || "error desconocido"}. Escríbele al cliente desde el Inbox.`;
            }

            return null;
        } catch (err) {
            return `La decisión quedó guardada, pero el aviso por WhatsApp no salió: ${
                err instanceof Error ? err.message : "error desconocido"
            }. Escríbele al cliente desde el Inbox.`;
        }
    }

    async function approve(order: QueueOrder) {
        const receipt = order.receipts.find(isReviewable);

        if (!receipt) {
            setError("Este pedido no tiene comprobante por revisar.");
            return;
        }

        if (!bankConfirmed[order.order_id]) {
            setError("Primero confirma en el banco que el dinero llegó.");
            return;
        }

        setBusyOrderId(order.order_id);
        setError(null);
        setNotice(null);

        try {
            const { data, error } = await supabase.rpc("approve_payment", {
                p_order_id: order.order_id,
                p_payment_reference: order.payment_reference,
                p_amount_cents: order.total_cents,
                p_receipt_id: receipt.id,
                p_note: approvalNote[order.order_id]?.trim() || null,
            });

            if (error) throw new Error(readableRpcError(error.message));

            const already = Boolean((data as { already_approved?: boolean } | null)?.already_approved);
            const notificationWarning = await notifyDecision(order);

            setNotice(
                already
                    ? `El pago ${order.payment_reference} ya estaba aprobado. No se duplicó nada.`
                    : `Pago ${order.payment_reference} aprobado. El pedido quedó listo para despacho.`,
            );

            setBankConfirmed((state) => ({ ...state, [order.order_id]: false }));
            setApprovalNote((state) => ({ ...state, [order.order_id]: "" }));
            await fetchQueue();
            setWarning(notificationWarning);
        } catch (err) {
            setError(err instanceof Error ? err.message : "No se pudo aprobar el pago.");
        } finally {
            setBusyOrderId(null);
        }
    }

    async function reject(order: QueueOrder) {
        const reason = (rejectReason[order.order_id] || "").trim();
        const receipt = order.receipts.find(isReviewable);

        if (reason.length < 5) {
            setError("Escribe un motivo de al menos 5 caracteres: el cliente lo va a leer.");
            return;
        }

        setBusyOrderId(order.order_id);
        setError(null);
        setNotice(null);

        try {
            const { error } = await supabase.rpc("reject_payment", {
                p_order_id: order.order_id,
                p_reason: reason,
                p_receipt_id: receipt?.id ?? null,
            });

            if (error) throw new Error(readableRpcError(error.message));

            const notificationWarning = await notifyDecision(order);

            setNotice(
                `Comprobante de ${order.payment_reference} rechazado. El pedido sigue pendiente de pago y el motivo quedó visible.`,
            );

            setRejectReason((state) => ({ ...state, [order.order_id]: "" }));
            await fetchQueue();
            setWarning(notificationWarning);
        } catch (err) {
            setError(err instanceof Error ? err.message : "No se pudo rechazar el comprobante.");
        } finally {
            setBusyOrderId(null);
        }
    }

    return (
        <div className="max-w-5xl space-y-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Pagos</h2>
                    <p className="text-sm text-muted-foreground">
                        Comprobantes Nequi / Bre-B pendientes de revisión humana
                    </p>
                </div>
                <button
                    type="button"
                    onClick={fetchQueue}
                    disabled={loading}
                    className="inline-flex items-center gap-2 self-start rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60 sm:self-auto"
                >
                    <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                    Actualizar
                </button>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {warning && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{warning}</span>
                </div>
            )}

            {notice && (
                <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <Check className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{notice}</span>
                </div>
            )}

            {queue && !queue.payment_config_complete && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    <p className="flex items-center gap-2 font-semibold">
                        <AlertTriangle className="h-4 w-4" />
                        Falta configurar la cuenta de recaudo
                    </p>
                    <p className="mt-1">
                        Sin número Nequi o llave Bre-B, el bot pausa el pedido y pide un asesor.{" "}
                        <Link to="/settings" className="font-semibold underline">
                            Completar en Settings
                        </Link>
                        .
                    </p>
                </div>
            )}

            <div className="grid gap-3 md:grid-cols-4">
                <StatCard label="Pendientes de pago" value={stats.pending} icon={<Banknote className="h-4 w-4" />} />
                <StatCard label="Con comprobante" value={stats.withReceipt} icon={<FileText className="h-4 w-4" />} />
                <StatCard label="Sin comprobante" value={stats.withoutReceipt} icon={<AlertTriangle className="h-4 w-4" />} />
                <StatCard
                    label="IA marcó diferencia"
                    value={stats.flagged}
                    icon={<ShieldCheck className="h-4 w-4" />}
                    highlight={stats.flagged > 0}
                />
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                La IA solo lee el comprobante. Aprobar o rechazar lo haces tú, después de ver el dinero en el banco.
                Un pedido aprobado compromete el stock reservado.
            </div>

            <DecisionsList decisions={decisions} />

            {loading && !queue ? (
                <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                    Cargando cola de pagos...
                </div>
            ) : (queue?.orders.length ?? 0) === 0 ? (
                <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                    No hay pedidos pendientes de pago.
                </div>
            ) : (
                <div className="space-y-4">
                    {queue?.orders.map((order) => (
                        <OrderCard
                            key={order.order_id}
                            order={order}
                            signedUrls={signedUrls}
                            bankConfirmed={Boolean(bankConfirmed[order.order_id])}
                            onBankConfirmedChange={(value) =>
                                setBankConfirmed((state) => ({ ...state, [order.order_id]: value }))
                            }
                            approvalNote={approvalNote[order.order_id] || ""}
                            onApprovalNoteChange={(value) =>
                                setApprovalNote((state) => ({ ...state, [order.order_id]: value }))
                            }
                            rejectReason={rejectReason[order.order_id] || ""}
                            onRejectReasonChange={(value) =>
                                setRejectReason((state) => ({ ...state, [order.order_id]: value }))
                            }
                            busy={busyOrderId === order.order_id}
                            onApprove={() => approve(order)}
                            onReject={() => reject(order)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function isReviewable(receipt: Receipt) {
    return receipt.status === "received" || receipt.status === "prevalidated";
}

function DecisionsList({ decisions }: { decisions: Decision[] }) {
    if (decisions.length === 0) return null;

    return (
        <section className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold">Decisiones recientes</h3>
                <p className="text-xs text-muted-foreground">
                    Auditoría inmutable: quién aprobó o rechazó cada pago
                </p>
            </div>
            <ul className="divide-y divide-border">
                {decisions.map((item) => (
                    <li key={item.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-2">
                            {item.decision === "approved" ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                                    <Check className="h-3 w-3" />
                                    Aprobado
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                                    <X className="h-3 w-3" />
                                    Rechazado
                                </span>
                            )}
                            <span className="font-mono text-xs font-semibold">{item.payment_reference}</span>
                            <span className="text-xs text-muted-foreground">{formatCents(item.amount_cents)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground sm:text-right">
                            <p>
                                {item.actor_email || "admin"} ·{" "}
                                {new Date(item.created_at).toLocaleString("es-CO")}
                            </p>
                            {item.note && <p className="max-w-xs truncate sm:max-w-sm">{item.note}</p>}
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function StatCard({
    label,
    value,
    icon,
    highlight,
}: {
    label: string;
    value: number;
    icon: React.ReactNode;
    highlight?: boolean;
}) {
    return (
        <div
            className={cn(
                "rounded-lg border p-4",
                highlight ? "border-amber-200 bg-amber-50 text-amber-950" : "border-border bg-card",
            )}
        >
            <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{label}</p>
                {icon}
            </div>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
        </div>
    );
}

function OrderCard({
    order,
    signedUrls,
    bankConfirmed,
    onBankConfirmedChange,
    approvalNote,
    onApprovalNoteChange,
    rejectReason,
    onRejectReasonChange,
    busy,
    onApprove,
    onReject,
}: {
    order: QueueOrder;
    signedUrls: Record<string, string>;
    bankConfirmed: boolean;
    onBankConfirmedChange: (value: boolean) => void;
    approvalNote: string;
    onApprovalNoteChange: (value: string) => void;
    rejectReason: string;
    onRejectReasonChange: (value: string) => void;
    busy: boolean;
    onApprove: () => void;
    onReject: () => void;
}) {
    const reviewable = order.receipts.filter(isReviewable);
    const previous = order.receipts.filter((receipt) => !isReviewable(receipt));

    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className="font-mono text-sm font-semibold">{order.payment_reference}</p>
                    <p className="text-xs text-muted-foreground">
                        {order.customer.name || "Cliente"} · {order.customer.phone || "sin teléfono"} · hace{" "}
                        {formatWaiting(order.waiting_hours)}
                    </p>
                </div>
                <div className="text-left sm:text-right">
                    <p className="text-xl font-bold">{formatCents(order.total_cents)}</p>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        {order.payment_method === "bre_b" ? "Bre-B" : "Nequi"}
                    </p>

                    {order.payment_shortfall_cents != null && order.payment_shortfall_cents > 0 && (
                        <p className="mt-1 text-xs font-semibold text-amber-700">
                            Abono {formatCents(order.payment_received_cents)} · faltan{" "}
                            {formatCents(order.payment_shortfall_cents)}
                        </p>
                    )}

                    {order.payment_shortfall_cents == null &&
                        order.payment_received_cents != null &&
                        order.payment_received_cents > order.total_cents && (
                            <p className="mt-1 text-xs font-semibold text-amber-700">
                                Pagó de más:{" "}
                                {formatCents(order.payment_received_cents - order.total_cents)}
                            </p>
                        )}

                    {order.payment_shortfall_cents == null &&
                        order.payment_received_cents != null &&
                        order.payment_received_cents <= order.total_cents && (
                            <p className="mt-1 text-xs font-semibold text-emerald-700">
                                El comprobante cubre el pedido
                            </p>
                        )}
                </div>
            </div>

            <div className="grid gap-4 p-4 md:grid-cols-2">
                <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Pedido
                    </h4>
                    <ul className="mt-2 space-y-1 text-sm">
                        {order.items.map((item, index) => (
                            <li key={`${order.order_id}-item-${index}`} className="flex justify-between gap-2">
                                <span>
                                    {item.product}
                                    {item.size ? ` · Talla ${item.size}` : ""} × {item.qty}
                                </span>
                                <span className="text-muted-foreground">
                                    {formatCents(item.unit_price_cents * item.qty)}
                                </span>
                            </li>
                        ))}
                    </ul>

                    {order.rejection_reason && (
                        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                            <strong>Motivo del rechazo anterior:</strong> {order.rejection_reason}
                        </div>
                    )}
                </div>

                <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Comprobantes
                    </h4>

                    {reviewable.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                            Sin comprobante por revisar. Pídeselo al cliente por WhatsApp.
                        </p>
                    ) : (
                        <div className="mt-2 space-y-2">
                            {reviewable.map((receipt) => (
                                <ReceiptRow
                                    key={receipt.id}
                                    receipt={receipt}
                                    signedUrl={signedUrls[receipt.id]}
                                />
                            ))}
                        </div>
                    )}

                    {previous.length > 0 && (
                        <p className="mt-3 text-xs text-muted-foreground">
                            {previous.length} comprobante(s) ya revisado(s) en este pedido.
                        </p>
                    )}
                </div>
            </div>

            <div className="grid gap-4 border-t border-border bg-muted/20 p-4 md:grid-cols-2">
                <div className="space-y-2">
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={bankConfirmed}
                            onChange={(event) => onBankConfirmedChange(event.target.checked)}
                            disabled={busy || reviewable.length === 0}
                            className="mt-0.5 h-4 w-4"
                        />
                        <span>
                            Confirmé en el banco que el dinero llegó y los datos coinciden.
                        </span>
                    </label>
                    <input
                        type="text"
                        value={approvalNote}
                        onChange={(event) => onApprovalNoteChange(event.target.value)}
                        disabled={busy}
                        placeholder="Nota interna (opcional)"
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                    <button
                        type="button"
                        onClick={onApprove}
                        disabled={busy || !bankConfirmed || reviewable.length === 0}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <BadgeCheck className="h-4 w-4" />
                        {busy ? "Procesando..." : "Aprobar pago"}
                    </button>
                </div>

                <div className="space-y-2">
                    <input
                        type="text"
                        value={rejectReason}
                        onChange={(event) => onRejectReasonChange(event.target.value)}
                        disabled={busy || reviewable.length === 0}
                        placeholder="Motivo visible para el cliente (mínimo 5 caracteres)"
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                        El pedido sigue pendiente de pago y conserva la reserva para que el cliente reintente.
                    </p>
                    <button
                        type="button"
                        onClick={onReject}
                        disabled={busy || rejectReason.trim().length < 5 || reviewable.length === 0}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                        {busy ? "Procesando..." : "Rechazar comprobante"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function ReceiptRow({ receipt, signedUrl }: { receipt: Receipt; signedUrl?: string }) {
    const verdict = receipt.ai_verdict ? VERDICT_LABELS[receipt.ai_verdict] : null;
    const amount = receipt.ai_extracted?.amount_cop;
    const reference = receipt.ai_extracted?.reference;
    const bank = receipt.ai_extracted?.bank;
    const date = receipt.ai_extracted?.date;
    const readFacts = [
        bank != null && String(bank).trim() ? `Entidad: ${String(bank)}` : null,
        amount != null ? `Monto leído: ${formatCents(Number(amount) * 100)}` : null,
        date != null && String(date).trim() ? `Fecha leída: ${String(date)}` : null,
        reference != null && String(reference).trim() ? `Referencia leída: ${String(reference)}` : null,
    ].filter((fact): fact is string => Boolean(fact));

    return (
        <div className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span>{receipt.content_type?.includes("pdf") ? "PDF" : "Imagen"}</span>
                    <span className="text-xs text-muted-foreground">
                        {new Date(receipt.created_at).toLocaleString("es-CO")}
                    </span>
                </div>
                {verdict && (
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", verdict.className)}>
                        {verdict.label}
                        {receipt.ai_confidence != null ? ` · ${Math.round(receipt.ai_confidence * 100)}%` : ""}
                    </span>
                )}
            </div>

            {readFacts.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                    {readFacts.join(" · ")}
                </p>
            )}

            {receipt.ai_evidence.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {receipt.ai_evidence.slice(0, 4).map((item, index) => (
                        <li key={`${receipt.id}-evidence-${index}`}>· {item.detail || item.kind}</li>
                    ))}
                </ul>
            )}

            {signedUrl ? (
                <a
                    href={signedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary underline"
                >
                    Ver comprobante <ExternalLink className="h-3 w-3" />
                </a>
            ) : (
                <p className="mt-2 text-xs text-muted-foreground">No se pudo generar el enlace del comprobante.</p>
            )}
        </div>
    );
}
