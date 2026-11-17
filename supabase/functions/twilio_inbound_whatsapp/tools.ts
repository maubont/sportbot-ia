import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
    buildOrderIdempotencyKey,
    canonicalizeItems,
} from "./idempotency.ts";
import { formatCop } from "./payments-core.ts";

export const toolsDefinition = [
    {
        type: "function",
        function: {
            name: "search_products",
            description: "Busca productos en el catálogo por nombre, modelo, marca o categoría.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Término de búsqueda (ej: 'jordan', 'nike running')" },
                    category: { type: "string", description: "Categoría opcional (ej: 'running', 'casual')" }
                },
            },
        }
    },
    {
        type: "function",
        function: {
            name: "check_stock",
            description: "Verifica disponibilidad de una talla específica para un producto.",
            parameters: {
                type: "object",
                properties: {
                    product_id: { type: "string", description: "Nombre, SKU o ID del producto" },
                    size: { type: "number", description: "Talla EU a verificar (ej: 42)" }
                },
                required: ["product_id", "size"]
            },
        }
    },
    {
        type: "function",
        function: {
            name: "create_order",
            description:
                "Crea un pedido de forma atómica y genera el link de pago. Exige el UUID exacto del producto y la talla numérica.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                product_id: { type: "string", description: "UUID exacto del producto devuelto por search_products/check_stock" },
                                size: { type: "number", description: "Talla" },
                                quantity: { type: "number", description: "Cantidad" }
                            }
                        }
                    },
                    shipping_city: { type: "string" },
                    shipping_address: { type: "string" },
                    shipping_name: { type: "string" }
                },
                required: ["items", "shipping_city", "shipping_address", "shipping_name"]
            },
        }
    },
    {
        type: "function",
        function: {
            name: "get_product_media",
            description: "Obtiene fotos o archivos PDF de un producto.",
            parameters: {
                type: "object",
                properties: {
                    product_id: { type: "string", description: "UUID o nombre del producto" },
                    type: {
                        type: "string",
                        enum: ["image", "pdf"],
                        description: "Tipo de multimedia"
                    }
                },
                required: ["product_id"]
            },
        }
    },
    {
        type: "function",
        function: {
            name: "get_order_status",
            description:
                "Consulta el estado real del pedido del cliente: pago, alistamiento, transportadora, guía, enlace de seguimiento y entrega. Úsala cuando pregunte dónde va su pedido, por la guía o cuándo llega.",
            parameters: {
                type: "object",
                properties: {
                    reference: {
                        type: "string",
                        description: "Referencia ORD-* que mencionó el cliente. Si no la dio, omítela."
                    },
                },
            },
        }
    },
];

function getAvailableStock(variant: { stock?: number; reserved?: number }) {
    return Math.max((variant.stock || 0) - (variant.reserved || 0), 0);
}

const searchStopWords = new Set([
    "el", "la", "los", "las", "un", "una", "de", "del", "en", "para",
    "que", "qué", "cual", "cuál", "cuales", "cuáles",
    "me", "mi", "mis", "por", "favor", "quiero", "busco", "buscar", "necesito",
    "tienes", "tiene", "tenes", "tienen", "tengan", "tenemos", "hay", "stock", "disponible", "disponibles",
    "seguro", "muestra", "muestras", "mostrar", "foto", "fotos", "imagen",
    "zapatilla", "zapatillas", "tenis", "zapato", "zapatos", "calzado",
    "catalogo", "catálogo", "variedad", "variedades", "opcion", "opción", "opciones",
    "modelo", "modelos", "marca", "marcas",
]);

function getSearchTokens(input = "") {
    const rawSearch = input.toLowerCase().trim();
    const tokens = rawSearch
        .split(/\s+/)
        .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((word) => word && !searchStopWords.has(word));

    return { rawSearch, tokens, searchTerm: tokens.join(" ") };
}

// Helper to resolve string/UUID to Product Record
export async function resolveProduct(supabase: SupabaseClient, input: string) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
    console.log(`[resolveProduct] Resolving: "${input}" (isUUID: ${isUUID})`);

    const { data: products } = await supabase
        .from("products")
        .select(`id, brand, model, sku, colorway, price_cents, product_variants(size, stock, reserved, id)`)
        .eq("active", true);

    if (!products) return null;

    if (isUUID) {
        return products.find(p => p.id === input) || null;
    }

    const { rawSearch, tokens, searchTerm } = getSearchTokens(input);

    console.log(`[resolveProduct] Raw: "${rawSearch}" -> Clean: "${searchTerm}"`);

    // GUARD: If search term is too short after cleaning (e.g. just "las" -> ""), return null
    if (searchTerm.length < 2) {
        console.log(`[resolveProduct] Term too short: "${searchTerm}"`);
        return null;
    }

    let best = null;
    let bestScore = 0;

    for (const p of products) {
        const brandModel = `${p.brand} ${p.model}`.toLowerCase();
        const fullText = `${brandModel} ${p.sku} ${p.colorway || ''}`.toLowerCase();
        const allTokensMatch = tokens.length > 0 && tokens.every((token) => fullText.includes(token));
        let score = 0;

        if (brandModel === searchTerm || p.model.toLowerCase() === searchTerm) score += 50;
        else if (fullText.includes(searchTerm)) score += 20;
        else if (allTokensMatch) score += 18;

        // ONLY add stock consideration if there's at least a valid text match
        if (score > 0) {
            const totalStock = (p.product_variants || []).reduce((s: number, v: any) => s + getAvailableStock(v), 0);
            if (totalStock > 0) score += 10;
        }

        if (score > bestScore) {
            bestScore = score;
            best = p;
        }
    }

    if (best && bestScore >= 10) {
        console.log(`[resolveProduct] SUCCESS: "${input}" -> ${best.brand} ${best.model}`);
        return best;
    }
    return null;
}

export async function searchProducts(supabase: SupabaseClient, query?: string, category?: string) {
    console.log(`[search_products] query=${query}, cat=${category}`);
    const { tokens, searchTerm } = getSearchTokens(query || "");

    const dbQuery = supabase
        .from("products")
        .select(`
            id, brand, model, sku, colorway, price_cents, category,
            variants:product_variants!inner(size, stock, reserved)
        `)
        .eq("active", true);

    const { data, error } = await dbQuery;
    if (error) return { error: error.message };

    const activeProducts = data || [];
    const normalizedCategory = category?.toLowerCase().trim();
    const categoryFilteredProducts = normalizedCategory
        ? activeProducts.filter((p: any) => String(p.category || "").toLowerCase().includes(normalizedCategory))
        : activeProducts;

    const catalogProductsWithStock = activeProducts
        .map((p: any) => {
            const availableSizes = (p.variants || [])
                .filter((v: any) => getAvailableStock(v) > 0)
                .map((v: any) => v.size)
                .sort((a: number, b: number) => a - b);

            return {
                id: p.id,
                name: `${p.brand} ${p.model}`,
                color: p.colorway,
                price_cop: p.price_cents / 100,
                available_sizes: availableSizes,
            };
        })
        .filter((p: any) => p.available_sizes.length > 0);

    const catalogHasStock = catalogProductsWithStock.length > 0;

    const results = categoryFilteredProducts
        .map((p: any) => {
            const brandModel = `${p.brand} ${p.model}`.toLowerCase();
            const fullText = `${brandModel} ${p.sku} ${p.colorway || ""} ${p.category || ""}`.toLowerCase();
            let score = 0;

            if (!searchTerm) score = 1;
            else if (brandModel === searchTerm || p.model.toLowerCase() === searchTerm) score = 50;
            else if (fullText.includes(searchTerm)) score = 25;
            else if (tokens.every((token) => fullText.includes(token))) score = 20;

            const availableSizes = (p.variants || [])
                .filter((v: any) => getAvailableStock(v) > 0)
                .map((v: any) => v.size)
                .sort((a: number, b: number) => a - b);

            return {
                id: p.id,
                name: `${p.brand} ${p.model}`,
                color: p.colorway,
                price_cop: p.price_cents / 100,
                available_sizes: availableSizes,
                _score: score,
            };
        })
        .filter((p: any) => p._score > 0)
        .filter((p: any) => p.available_sizes.length > 0);

    results.sort((a: any, b: any) => b._score - a._score);

    const suggestedProducts = results.length === 0 && catalogHasStock
        ? catalogProductsWithStock.slice(0, 3)
        : [];

    const message = results.length > 0
        ? `Encontrados ${results.length} modelos con stock.`
        : catalogHasStock
            ? "No encontre coincidencias claras para esa busqueda, pero si hay productos con stock en el catalogo. Pide una marca o modelo mas concreto, o sugiere alternativas disponibles."
            : "No hay productos activos con stock disponible.";

    return {
        products: results,
        message,
        result_count: results.length,
        catalog_has_stock: catalogHasStock,
        catalog_products_with_stock: catalogProductsWithStock.length,
        suggested_products: suggestedProducts,
    };
}

export async function checkStock(supabase: SupabaseClient, productId: string, size: number) {
    const p = await resolveProduct(supabase, productId);
    if (!p) return { error: "Producto no encontrado" };

    const sizeNum = Number(size);
    const variants = p.product_variants || [];
    const available_sizes = variants.filter((v: any) => getAvailableStock(v) > 0).map((v: any) => v.size).sort();
    const match = variants.find((v: any) => Number(v.size) === sizeNum && getAvailableStock(v) > 0);

    console.log(`[check_stock] ${p.brand} ${p.model} size ${sizeNum} -> ${match ? 'FOUND' : 'NOT FOUND'}`);

    if (match) {
        return {
            available: true,
            product_id: p.id,
            product_name: `${p.brand} ${p.model}`,
            size: sizeNum,
            stock: getAvailableStock(match),
            variant_id: match.id,
            message: ` ✅ Sí hay stock de ${p.brand} ${p.model} en talla ${sizeNum}.`
        };
    }

    return {
        available: false,
        product_id: p.id,
        product_name: `${p.brand} ${p.model}`,
        available_sizes,
        message: `❌ No hay talla ${sizeNum}. Disponibles: ${available_sizes.join(", ")}`
    };
}

export async function getProductMedia(supabase: SupabaseClient, productId: string, type?: string) {
    const p = await resolveProduct(supabase, productId);
    if (!p) return { error: "Producto no encontrado" };

    let q = supabase.from("product_media").select("url, media_type, is_primary").eq("product_id", p.id);
    if (type) q = q.eq("media_type", type);

    const { data } = await q;
    return { media: data || [], product_id: p.id, product_name: `${p.brand} ${p.model}` };
}

// ---------------------------------------------------------------------------
// Seguimiento del pedido
// ---------------------------------------------------------------------------
//
// El bot antes solo sabía decir "está en revisión", incluso cuando el pedido ya
// iba con la transportadora. Esta herramienta lee la verdad de `orders`,
// `shipments` y `shipment_events`, siempre acotada al cliente de la
// conversación: una referencia ajena no devuelve nada.

export type OrderStatusSnapshot = {
    order: {
        status: string;
        payment_reference?: string | null;
        total_cents?: number | null;
        shipping_city?: string | null;
        carrier_name?: string | null;
        tracking_number?: string | null;
        shipped_at?: string | null;
        delivered_at?: string | null;
    };
    ship?: {
        status?: string | null;
        carrier_name?: string | null;
        tracking_number?: string | null;
        tracking_url?: string | null;
        service_level?: string | null;
        shipped_at?: string | null;
        delivered_at?: string | null;
    } | null;
    items?: Array<{ qty?: number | null; name?: string | null }> | null;
};

export type OrderStatusReply = {
    state: string;
    message: string;
    handoff_required: boolean;
};

function formatDateCop(value?: string | null): string {
    if (!value) return "";
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return "";
    try {
        return new Intl.DateTimeFormat("es-CO", {
            timeZone: "America/Bogota",
            day: "numeric",
            month: "long",
        }).format(at);
    } catch {
        return at.toISOString().slice(0, 10);
    }
}

function buildItemsLine(items?: OrderStatusSnapshot["items"]): string | null {
    const clean = (items || []).filter((item) => item && Number(item.qty) > 0);
    if (clean.length === 0) return null;

    const shown = clean
        .slice(0, 3)
        .map((item) => `${Number(item.qty)} × ${(item.name || "producto").trim()}`);
    const extra = clean.length - shown.length;

    return `Producto${clean.length === 1 ? "" : "s"}: ${shown.join(", ")}${extra > 0 ? ` y ${extra} más` : ""}.`;
}

/**
 * Arma el mensaje de estado con lo que hay en la base.
 *
 * Es determinista a propósito: si falta un dato (transportadora, guía, fecha),
 * el mensaje simplemente no lo menciona. Nunca inventa un paso del envío.
 */
export function buildOrderStatusMessage(snapshot: OrderStatusSnapshot): OrderStatusReply {
    const { order } = snapshot;
    const ship = snapshot.ship ?? null;
    const reference = (order.payment_reference || "").trim();
    const label = reference ? `*${reference}*` : "tu pedido";
    const carrier = (ship?.carrier_name || order.carrier_name || "").trim();
    const tracking = (ship?.tracking_number || order.tracking_number || "").trim();
    const trackingUrl = (ship?.tracking_url || "").trim();
    const itemLine = buildItemsLine(snapshot.items);
    const orderStatus = String(order.status || "");
    const shipStatus = String(ship?.status || "");

    const join = (...parts: Array<string | null | undefined | false>) =>
        parts
            .filter((part): part is string => Boolean(part && String(part).trim()))
            .join("\n");

    const trackingLines = join(
        carrier ? `Transportadora: ${carrier}.` : null,
        tracking ? `Guía: ${tracking}.` : null,
        trackingUrl || null,
    );

    if (orderStatus === "cancelled" || shipStatus === "cancelled") {
        return {
            state: "cancelled",
            handoff_required: true,
            message: join(
                `Tu pedido ${label} aparece cancelado.`,
                itemLine,
                "Si ya habías pagado, escríbeme por aquí y una persona del equipo lo revisa.",
            ),
        };
    }

    if (orderStatus === "awaiting_payment") {
        const total =
            typeof order.total_cents === "number" ? `Total: ${formatCop(order.total_cents)}.` : null;

        return {
            state: "awaiting_payment",
            handoff_required: false,
            message: join(
                `🧾 Tu pedido ${label} está en espera del pago.`,
                itemLine,
                total,
                "Si ya pagaste, envíame la foto del comprobante por aquí y una persona lo revisa.",
            ),
        };
    }

    if (orderStatus === "draft") {
        return {
            state: "registered",
            handoff_required: false,
            message: join(
                `Tu pedido ${label} quedó registrado pero todavía no está confirmado.`,
                itemLine,
                "Te aviso por aquí apenas quede listo.",
            ),
        };
    }

    if (orderStatus === "delivered" || shipStatus === "delivered") {
        const deliveredAt = formatDateCop(ship?.delivered_at || order.delivered_at);

        return {
            state: "delivered",
            handoff_required: false,
            message: join(
                `✅ Tu pedido ${label} ya fue entregado${deliveredAt ? ` el ${deliveredAt}` : ""}.`,
                "Gracias por tu compra. Si algo no está bien, escríbeme por aquí y lo revisamos.",
            ),
        };
    }

    if (shipStatus === "exception") {
        return {
            state: "exception",
            handoff_required: true,
            message: join(
                `⚠️ La transportadora reportó una novedad con tu pedido ${label}.`,
                trackingLines,
                "Una persona del equipo lo está revisando y te escribe por este chat.",
            ),
        };
    }

    if (
        shipStatus === "shipped" ||
        shipStatus === "in_transit" ||
        shipStatus === "out_for_delivery" ||
        orderStatus === "shipped"
    ) {
        return {
            state: "in_transit",
            handoff_required: false,
            message: join(
                `🚚 Tu pedido ${label} va en camino${carrier ? ` con ${carrier}` : ""}.`,
                trackingLines,
                shipStatus === "out_for_delivery"
                    ? "Hoy sale para entrega."
                    : "Te aviso por aquí cuando se entregue.",
            ),
        };
    }

    if (shipStatus === "label_created") {
        return {
            state: "label_created",
            handoff_required: false,
            message: join(
                `📦 Ya generamos la guía de tu pedido ${label}.`,
                trackingLines,
                "Aún no sale: la transportadora lo recoge pronto.",
            ),
        };
    }

    if (
        orderStatus === "paid" ||
        shipStatus === "ready_to_fulfill" ||
        shipStatus === "picking" ||
        shipStatus === "packed"
    ) {
        return {
            state: "preparing",
            handoff_required: false,
            message: join(
                `✅ Tu pago está confirmado y estamos alistando tu pedido ${label}.`,
                itemLine,
                "Te aviso por aquí cuando salga con la transportadora.",
            ),
        };
    }

    return {
        state: "registered",
        handoff_required: false,
        message: join(
            `Tu pedido ${label} está registrado y en proceso.`,
            itemLine,
            trackingLines,
        ),
    };
}

/**
 * Estado del pedido del cliente de esta conversación.
 *
 * `customerId` manda: si el cliente escribe la referencia de otra persona, la
 * consulta filtrada no devuelve nada y el bot pide la suya. No se confía en el
 * texto del mensaje para decidir de quién es el pedido.
 */
export async function getOrderStatus(
    supabase: SupabaseClient,
    customerId: string,
    reference?: string | null,
) {
    const trimmedReference = String(reference || "").trim().toUpperCase();

    if (!customerId) {
        return {
            found: false,
            state: "not_found",
            handoff_required: false,
            message: "No pude identificar tu pedido. Pásame la referencia ORD-* que te llegó por aquí.",
        };
    }

    let ordersQuery = supabase
        .from("orders")
        .select(
            "id, status, payment_reference, total_cents, shipping_city, created_at, paid_at, shipped_at, delivered_at, carrier_name, tracking_number",
        )
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(5);

    if (trimmedReference) {
        ordersQuery = ordersQuery.eq("payment_reference", trimmedReference);
    }

    const { data: orders, error } = await ordersQuery;
    if (error) return { error: error.message };

    const list: any[] = Array.isArray(orders) ? orders : [];

    if (list.length === 0) {
        return {
            found: false,
            state: "not_found",
            handoff_required: false,
            message: trimmedReference
                ? `No encontré el pedido ${trimmedReference} a tu nombre. Revísame la referencia o los datos con los que hiciste la compra.`
                : "No veo un pedido reciente a tu nombre. Si acabas de comprar, pásame la referencia ORD-* que te llegó por aquí.",
        };
    }

    // El pedido más reciente que siga vivo; si todos están cancelados, el último.
    const order = list.find((row) => row.status !== "cancelled") ?? list[0];

    const { data: itemRows } = await supabase
        .from("order_items")
        .select("qty, products(brand, model)")
        .eq("order_id", order.id);

    const items = (Array.isArray(itemRows) ? itemRows : []).map((row: any) => {
        const product = Array.isArray(row.products) ? row.products[0] : row.products;
        const name = product
            ? `${product.brand ?? ""} ${product.model ?? ""}`.trim()
            : null;

        return { qty: Number(row.qty) || 0, name };
    });

    const { data: shipRows } = await supabase
        .from("shipments")
        .select("status, carrier_name, tracking_number, tracking_url, service_level, shipped_at, delivered_at")
        .eq("order_id", order.id)
        .neq("status", "cancelled")
        .order("shipment_number", { ascending: false })
        .limit(1);

    const ship = Array.isArray(shipRows) && shipRows.length > 0 ? shipRows[0] : null;

    const built = buildOrderStatusMessage({ order, ship, items });

    return {
        found: true,
        order_id: order.id,
        reference: order.payment_reference ?? null,
        order_status: order.status ?? null,
        shipment_status: ship?.status ?? null,
        state: built.state,
        handoff_required: built.handoff_required,
        total_cents: order.total_cents ?? null,
        carrier: ship?.carrier_name || order.carrier_name || null,
        tracking_number: ship?.tracking_number || order.tracking_number || null,
        tracking_url: ship?.tracking_url || null,
        items,
        message: built.message,
    };
}

export type CreateOrderContext = {
    conversationId: string;
    messageSid: string;
};

const ORDER_RPC_ERRORS: Record<string, string> = {
    PRODUCT_VARIANT_NOT_FOUND:
        "No encontramos esa talla para uno de los productos. Verifica la talla con check_stock antes de reintentar.",
    INSUFFICIENT_STOCK:
        "No hay stock suficiente para uno de los productos en la talla elegida.",
    INVALID_ITEM:
        "El pedido tiene un ítem inválido. Usa el product_id exacto que devolvió search_products/check_stock y una talla numérica.",
    INVALID_SHIPPING:
        "Faltan datos de envío. Necesito nombre completo, ciudad y dirección.",
    CUSTOMER_NOT_FOUND:
        "No pudimos identificar al cliente. Escala a un humano.",
};

function mapOrderRpcError(message: string): string | null {
    for (const [code, friendly] of Object.entries(ORDER_RPC_ERRORS)) {
        if (message.includes(code)) return friendly;
    }
    return null;
}

/**
 * Crea un pedido a través de `create_order_atomic`.
 *
 * La RPC es la única puerta: resuelve producto+talla, bloquea la variante,
 * calcula el precio desde la base y reserva el stock en una sola transacción.
 * Aquí no se inserta nada directamente ni se confía en el precio del modelo.
 * La clave se limita al ID estable del mensaje del proveedor: un evento solo crea un pedido aunque
 * el modelo reintente con argumentos distintos; otro mensaje admite recompra.
 */
export async function createOrder(
    supabase: SupabaseClient,
    customerId: string,
    items: any[],
    shippingCity: string,
    shippingAddress: string,
    shippingName: string,
    context: CreateOrderContext
) {
    console.log(`[create_order] Start for customer ${customerId}`);

    if (!Array.isArray(items) || items.length === 0) {
        return { error: ORDER_RPC_ERRORS.INVALID_ITEM };
    }
    if (!context?.conversationId || !context?.messageSid?.trim()) {
        throw new Error("createOrder requiere conversationId y messageSid para la idempotencia");
    }

    const shipping = {
        name: shippingName ?? "",
        city: shippingCity ?? "",
        address: shippingAddress ?? "",
    };

    const idempotencyKey = await buildOrderIdempotencyKey({
        customerId,
        conversationId: context.conversationId,
        messageSid: context.messageSid,
    });

    const { data, error } = await supabase.rpc("create_order_atomic", {
        p_customer_id: customerId,
        p_items: canonicalizeItems(items),
        p_shipping: shipping,
        p_idempotency_key: idempotencyKey,
    });

    if (error) {
        const friendly = mapOrderRpcError(String(error.message || ""));
        if (friendly) return { error: friendly };
        throw error;
    }

    const order = (data ?? {}) as {
        success?: boolean;
        order_id?: string;
        payment_reference?: string;
        total_cents?: number;
        item_count?: number;
        quantity?: number;
        deduplicated?: boolean;
        duplicate_reason?: string;
    };

    if (!order.success || !order.order_id || !order.payment_reference) {
        throw new Error("create_order_atomic devolvió una respuesta incompleta");
    }

    console.log(
        `[create_order] ${order.deduplicated ? "deduplicated" : "created"} ${order.order_id} (${order.total_cents} cents)`
    );

    return {
        success: true,
        order_id: order.order_id,
        payment_reference: order.payment_reference,
        total_cents: order.total_cents ?? 0,
        item_count: order.item_count ?? 0,
        quantity: order.quantity ?? 0,
        deduplicated: Boolean(order.deduplicated),
        message: !order.deduplicated
            ? `Pedido creado con la referencia ${order.payment_reference} por ${formatCop(order.total_cents ?? 0)} COP.`
            : order.duplicate_reason === "active_identical_order"
                ? `Ya tienes un pedido idéntico activo con la referencia ${order.payment_reference}. No se creó otro; si necesitas modificarlo, contacta a un asesor.`
                : `Tu pedido ya estaba registrado con la referencia ${order.payment_reference}.`,
    };
}

export async function getStoreInfo(supabase: SupabaseClient) {
    const normalizePublicUrl = (value?: string | null) => {
        const trimmed = value?.trim();
        if (!trimmed) return null;
        if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(trimmed)) return null;
        if (!/^https:\/\//i.test(trimmed)) return null;
        return trimmed;
    };

    const { data: settings } = await supabase
        .from("settings")
        .select("store_name, welcome_message, storefront_url, welcome_image_url, catalog_pdf_url")
        .eq("id", 1)
        .maybeSingle();

    let welcomeImage = normalizePublicUrl(settings?.welcome_image_url || Deno.env.get("STORE_WELCOME_IMAGE_URL"));
    const catalogPdf = normalizePublicUrl(settings?.catalog_pdf_url || Deno.env.get("STORE_CATALOG_PDF_URL"));
    const storeUrl = normalizePublicUrl(settings?.storefront_url || Deno.env.get("STOREFRONT_URL"));

    if (!welcomeImage) {
        const { data: media } = await supabase
            .from("product_media")
            .select("url")
            .eq("media_type", "image")
            .not("url", "ilike", "%Python-logo-notext%")
            .not("url", "ilike", "%python-logo%")
            .order("is_primary", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        welcomeImage = normalizePublicUrl(media?.url);
    }

    return {
        store_name: settings?.store_name || "SportBot",
        welcome_message: settings?.welcome_message || "Hola, bienvenido a SportBot. Somos especialistas en sneakers exclusivos en Colombia.",
        welcome_image: welcomeImage,
        catalog_pdf: catalogPdf,
        store_url: storeUrl
    };
}

/**
 * Texto del saludo.
 *
 * El saludo sale **sin adjuntos**, así que solo se puede prometer lo que se
 * entrega como enlace. Antes decía "te comparto nuestro catálogo actualizado" y
 * no adjuntaba ni enlazaba nada: el cliente quedaba esperando un archivo.
 *
 * La tienda gana al PDF porque el PDF es una foto del inventario y se queda
 * viejo el mismo día que cambia un precio o una talla. El PDF queda como
 * respaldo para quien no tenga buena conexión o lo pida como archivo.
 */
export function buildWelcomeText(store: {
    welcome_message: string;
    catalog_pdf: string | null;
    store_url: string | null;
}): string {
    const catalogLine = store.store_url
        ? `Puedes ver el catálogo con fotos, tallas y precios: ${store.store_url}`
        : store.catalog_pdf
            ? `Te comparto el catálogo en PDF: ${store.catalog_pdf}`
            : "Puedo mostrarte fotos, tallas disponibles y precios por marca o modelo.";

    return [
        store.welcome_message,
        "",
        catalogLine,
        "",
        "¿Buscas alguna marca en especial? Ej: Jordan, Nike, Adidas.",
    ].join("\n");
}


