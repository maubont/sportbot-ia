import { type ReactNode, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { supabase } from "../lib/supabase";

type SettingsRow = {
    store_name: string | null;
    welcome_message: string | null;
    system_prompt: string | null;
    storefront_url: string | null;
    welcome_image_url: string | null;
    catalog_pdf_url: string | null;
    twilio_whatsapp_number: string | null;
    fulfillment_sla_hours: number | null;
    delivery_sla_hours: number | null;
    payment_nequi_number: string | null;
    payment_nequi_holder: string | null;
    payment_breb_key: string | null;
    payment_breb_holder: string | null;
    payment_instructions: string | null;
    payment_receipt_window_hours: number | null;
};

function emptyToNull(value: string) {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function positiveNumberOrNull(value: string) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

export default function Settings() {
    const [form, setForm] = useState({
        storeName: "",
        welcomeMessage: "",
        systemPrompt: "",
        storefrontUrl: "",
        welcomeImageUrl: "",
        catalogPdfUrl: "",
        twilioWhatsappNumber: "",
        fulfillmentSlaHours: "24",
        deliverySlaHours: "72",
        paymentNequiNumber: "",
        paymentNequiHolder: "",
        paymentBrebKey: "",
        paymentBrebHolder: "",
        paymentInstructions: "",
        paymentReceiptWindowHours: "24",
    });
    const [loading, setLoading] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchSettings();
    }, []);

    async function fetchSettings() {
        setLoading(true);
        setError(null);

        const { data, error } = await supabase
            .from("settings")
            .select("store_name, welcome_message, system_prompt, storefront_url, welcome_image_url, catalog_pdf_url, twilio_whatsapp_number, fulfillment_sla_hours, delivery_sla_hours, payment_nequi_number, payment_nequi_holder, payment_breb_key, payment_breb_holder, payment_instructions, payment_receipt_window_hours")
            .eq("id", 1)
            .maybeSingle();

        setLoading(false);

        if (error) {
            setError(error.message);
            return;
        }

        const settings = data as SettingsRow | null;
        if (!settings) return;

        setForm({
            storeName: settings.store_name || "",
            welcomeMessage: settings.welcome_message || "",
            systemPrompt: settings.system_prompt || "",
            storefrontUrl: settings.storefront_url || "",
            welcomeImageUrl: settings.welcome_image_url || "",
            catalogPdfUrl: settings.catalog_pdf_url || "",
            twilioWhatsappNumber: settings.twilio_whatsapp_number || "",
            fulfillmentSlaHours: String(settings.fulfillment_sla_hours || 24),
            deliverySlaHours: String(settings.delivery_sla_hours || 72),
            paymentNequiNumber: settings.payment_nequi_number || "",
            paymentNequiHolder: settings.payment_nequi_holder || "",
            paymentBrebKey: settings.payment_breb_key || "",
            paymentBrebHolder: settings.payment_breb_holder || "",
            paymentInstructions: settings.payment_instructions || "",
            paymentReceiptWindowHours: String(settings.payment_receipt_window_hours || 24),
        });
    }

    async function saveSettings() {
        setLoading(true);
        setNotice(null);
        setError(null);

        const { error } = await supabase.from("settings").upsert({
            id: 1,
            store_name: emptyToNull(form.storeName),
            welcome_message: emptyToNull(form.welcomeMessage),
            system_prompt: emptyToNull(form.systemPrompt),
            storefront_url: emptyToNull(form.storefrontUrl),
            welcome_image_url: emptyToNull(form.welcomeImageUrl),
            catalog_pdf_url: emptyToNull(form.catalogPdfUrl),
            twilio_whatsapp_number: emptyToNull(form.twilioWhatsappNumber),
            fulfillment_sla_hours: positiveNumberOrNull(form.fulfillmentSlaHours),
            delivery_sla_hours: positiveNumberOrNull(form.deliverySlaHours),
            payment_nequi_number: emptyToNull(form.paymentNequiNumber),
            payment_nequi_holder: emptyToNull(form.paymentNequiHolder),
            payment_breb_key: emptyToNull(form.paymentBrebKey),
            payment_breb_holder: emptyToNull(form.paymentBrebHolder),
            payment_instructions: emptyToNull(form.paymentInstructions),
            payment_receipt_window_hours: positiveNumberOrNull(form.paymentReceiptWindowHours) || 24,
            updated_at: new Date().toISOString()
        });

        setLoading(false);

        if (error) {
            setError(error.message);
            return;
        }

        setNotice("Configuración guardada.");
    }

    return (
        <div className="max-w-3xl space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                <button
                    onClick={saveSettings}
                    disabled={loading}
                    className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                    <Save className="h-4 w-4" />
                    {loading ? "Saving..." : "Save Changes"}
                </button>
            </div>

            {error && (
                <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
                    {error}
                </div>
            )}
            {notice && (
                <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
                    {notice}
                </div>
            )}

            <div className="space-y-5 rounded-lg border border-border bg-card p-5">
                <Field label="Store name">
                    <input
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={form.storeName}
                        onChange={(e) => setForm({ ...form, storeName: e.target.value })}
                    />
                </Field>

                <Field label="WhatsApp number">
                    <input
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={form.twilioWhatsappNumber}
                        onChange={(e) => setForm({ ...form, twilioWhatsappNumber: e.target.value })}
                    />
                </Field>

                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Fulfillment SLA (hours)">
                        <input
                            type="number"
                            min={1}
                            step={1}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={form.fulfillmentSlaHours}
                            onChange={(e) => setForm({ ...form, fulfillmentSlaHours: e.target.value })}
                        />
                    </Field>

                    <Field label="Delivery SLA (hours)">
                        <input
                            type="number"
                            min={1}
                            step={1}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={form.deliverySlaHours}
                            onChange={(e) => setForm({ ...form, deliverySlaHours: e.target.value })}
                        />
                    </Field>
                </div>

                <div className="rounded-lg border border-cyan-100 bg-cyan-50/40 p-4">
                    <h3 className="text-sm font-semibold text-slate-900">Cobros manuales (Nequi / Bre-B)</h3>
                    <p className="mt-1 text-xs text-slate-600">
                        Estos datos los escribe el sistema tal cual en el mensaje de pago: ningún modelo los inventa.
                        Si dejas ambos vacíos, el bot pausa el pedido y un asesor comparte la cuenta.
                    </p>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <Field label="Número Nequi del negocio">
                            <input
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                placeholder="Ej2025550102"
                                value={form.paymentNequiNumber}
                                onChange={(e) => setForm({ ...form, paymentNequiNumber: e.target.value })}
                            />
                        </Field>

                        <Field label="Titular Nequi">
                            <input
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                placeholder="Nombre o razón social"
                                value={form.paymentNequiHolder}
                                onChange={(e) => setForm({ ...form, paymentNequiHolder: e.target.value })}
                            />
                        </Field>

                        <Field label="Llave Bre-B">
                            <input
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                placeholder="Ej2025550102 o correo"
                                value={form.paymentBrebKey}
                                onChange={(e) => setForm({ ...form, paymentBrebKey: e.target.value })}
                            />
                        </Field>

                        <Field label="Titular Bre-B">
                            <input
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                value={form.paymentBrebHolder}
                                onChange={(e) => setForm({ ...form, paymentBrebHolder: e.target.value })}
                            />
                        </Field>
                    </div>

                    <div className="mt-4 space-y-4">
                        <Field label="Instrucciones adicionales (opcional)">
                            <textarea
                                className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                placeholder="Ej. Escribe tu nombre en la descripción de la transferencia."
                                value={form.paymentInstructions}
                                onChange={(e) => setForm({ ...form, paymentInstructions: e.target.value })}
                            />
                        </Field>

                        <Field label="Horas de reserva esperando comprobante">
                            <input
                                type="number"
                                min={1}
                                step={1}
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm md:max-w-[180px]"
                                value={form.paymentReceiptWindowHours}
                                onChange={(e) => setForm({ ...form, paymentReceiptWindowHours: e.target.value })}
                            />
                        </Field>
                    </div>
                </div>

                <Field label="Welcome message">
                    <textarea
                        className="min-h-[110px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={form.welcomeMessage}
                        onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
                    />
                </Field>

                <Field label="Storefront URL">
                    <input
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={form.storefrontUrl}
                        onChange={(e) => setForm({ ...form, storefrontUrl: e.target.value })}
                    />
                </Field>

                <Field label="Welcome image URL">
                    <input
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={form.welcomeImageUrl}
                        onChange={(e) => setForm({ ...form, welcomeImageUrl: e.target.value })}
                    />
                </Field>

                <Field label="Catalog PDF URL">
                    <input
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={form.catalogPdfUrl}
                        onChange={(e) => setForm({ ...form, catalogPdfUrl: e.target.value })}
                    />
                </Field>

                <Field label="System prompt">
                    <textarea
                        className="min-h-[150px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={form.systemPrompt}
                        onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                    />
                </Field>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{label}</span>
            {children}
        </label>
    );
}
