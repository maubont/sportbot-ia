import { SupabaseClient } from "npm:@supabase/supabase-js@2";

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
            description: "Crea un pedido y genera un link de pago de Wompi.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                product_id: { type: "string", description: "UUID o nombre del producto" },
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
            name: "get_store_info",
            description: "Obtiene información de la tienda: Imagen de bienvenida y Catálogo PDF.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
        }
    },
];

// Helper to resolve string/UUID to Product Record
// Helper to resolve string/UUID to Product Record
export async function resolveProduct(supabase: SupabaseClient, input: string) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
    console.log(`[resolveProduct] Resolving: "${input}" (isUUID: ${isUUID})`);

    const { data: products } = await supabase
        .from("products")
        .select(`id, brand, model, sku, colorway, price_cents, product_variants(size, stock, id)`)
        .eq("active", true);

    if (!products) return null;

    if (isUUID) {
        return products.find(p => p.id === input) || null;
    }

    // Remove common Spanish stop words to improve matching (e.g. "las jordan" -> "jordan")
    const stopWords = ["el", "la", "los", "las", "un", "una", "de", "del", "en", "para"];
    const rawSearch = input.toLowerCase().trim();
    const searchTerm = rawSearch.split(" ").filter(w => !stopWords.includes(w)).join(" ");

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
        let score = 0;

        if (brandModel === searchTerm || p.model.toLowerCase() === searchTerm) score += 50;
        else if (fullText.includes(searchTerm)) score += 20;

        // ONLY add stock consideration if there's at least a valid text match
        if (score > 0) {
            const totalStock = (p.product_variants || []).reduce((s: number, v: any) => s + (v.stock || 0), 0);
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
    let dbQuery = supabase
        .from("products")
        .select(`
            id, brand, model, sku, colorway, price_cents, category,
            variants:product_variants!inner(size, stock)
        `)
        .eq("active", true)
        .gt("product_variants.stock", 0);

    if (category) dbQuery = dbQuery.ilike("category", category);
    if (query) dbQuery = dbQuery.or(`model.ilike.%${query}%,brand.ilike.%${query}%,sku.ilike.%${query}%`);

    const { data, error } = await dbQuery;
    if (error) return { error: error.message };

    const results = (data || []).map((p: any) => ({
        id: p.id,
        name: `${p.brand} ${p.model}`,
        color: p.colorway,
        price_cop: p.price_cents / 100,
        available_sizes: (p.variants || []).map((v: any) => v.size).sort((a: number, b: number) => a - b)
    }));

    return { products: results, message: `Encontrados ${results.length} modelos con stock.` };
}

export async function checkStock(supabase: SupabaseClient, productId: string, size: number) {
    const p = await resolveProduct(supabase, productId);
    if (!p) return { error: "Producto no encontrado" };

    const sizeNum = Number(size);
    const variants = p.product_variants || [];
    const available_sizes = variants.filter((v: any) => v.stock > 0).map((v: any) => v.size).sort();
    const match = variants.find((v: any) => Number(v.size) === sizeNum && v.stock > 0);

    console.log(`[check_stock] ${p.brand} ${p.model} size ${sizeNum} -> ${match ? 'FOUND' : 'NOT FOUND'}`);

    if (match) {
        return {
            available: true,
            product_name: `${p.brand} ${p.model}`,
            size: sizeNum,
            stock: match.stock,
            variant_id: match.id,
            message: ` ✅ Sí hay stock de ${p.brand} ${p.model} en talla ${sizeNum}.`
        };
    }

    return {
        available: false,
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
    return { media: data || [], product_name: `${p.brand} ${p.model}` };
}

export async function createOrder(
    supabase: SupabaseClient,
    customerId: string,
    items: any[],
    shippingCity: string,
    shippingAddress: string,
    shippingName: string
) {
    console.log(`[create_order] Start for customer ${customerId}`);
    let totalCents = 0;
    const orderItems = [];

    for (const item of items) {
        const p = await resolveProduct(supabase, item.product_id);
        if (!p) throw new Error(`Producto ${item.product_id} no encontrado`);

        const variant = p.product_variants.find((v: any) => Number(v.size) === Number(item.size));
        if (!variant || variant.stock < (item.quantity || 1)) {
            return { error: `No hay stock suficiente para ${p.brand} ${p.model} en talla ${item.size}` };
        }

        totalCents += p.price_cents * (item.quantity || 1);
        orderItems.push({
            product_id: p.id,
            variant_id: variant.id,
            qty: item.quantity || 1,
            unit_price_cents: p.price_cents
        });
    }

    const paymentRef = `ORD-${Date.now()}`;
    const { data: order, error: ordErr } = await supabase.from("orders").insert({
        customer_id: customerId,
        status: "awaiting_payment",
        shipping_name: shippingName,
        shipping_city: shippingCity,
        shipping_address: shippingAddress,
        total_cents: totalCents,
        subtotal_cents: totalCents,
        payment_reference: paymentRef
    }).select().single();

    if (ordErr) throw ordErr;

    await supabase.from("order_items").insert(orderItems.map(i => ({ ...i, order_id: order.id })));

    // --- PROACTIVE STOCK RESERVATION ---
    // Deduct stock immediately to reserve it for this potential payment.
    // If payment fails or expires, we rely on webhooks or manual admin tools to restore it.
    for (const item of orderItems) {
        const { error: stockErr } = await supabase.rpc('decrement_stock', {
            row_id: item.variant_id,
            amount: item.qty
        });

        // Fallback if RPC doesn't exist (simpler direct update, though less atomic)
        if (stockErr) {
            const { data: v } = await supabase.from("product_variants").select("stock").eq("id", item.variant_id).single();
            if (v) {
                await supabase.from("product_variants").update({ stock: v.stock - item.qty }).eq("id", item.variant_id);
            }
        }
    }

    const { data: settings } = await supabase.from("settings").select("*").single();

    // Fallback to env vars if settings are missing/null
    const wompiPub = settings?.wompi_public_key || Deno.env.get("WOMPI_PUBLIC_KEY");
    const wompiSec = settings?.wompi_integrity_secret || Deno.env.get("WOMPI_INTEGRITY_SECRET");

    if (!wompiPub || !wompiSec) {
        throw new Error("Faltan credenciales de pago (Wompi Public Key / Integrity Secret)");
    }

    const signature = `${paymentRef}${totalCents}COP${wompiSec}`;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
    const integrity = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');

    const checkoutUrl = `https://checkout.wompi.co/p/?public-key=${wompiPub}&currency=COP&amount-in-cents=${totalCents}&reference=${paymentRef}&signature:integrity=${integrity}`;

    return {
        success: true,
        checkout_url: checkoutUrl,
        message: `¡Pedido creado! Paga aquí: ${checkoutUrl}`
    };
}

export async function getStoreInfo(supabase: SupabaseClient) {
    // Reliable Welcome Image: Using verified Wikimedia URL (Python Logo or generic) to ensure delivery
    const welcomeImage = "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Python-logo-notext.svg/1200px-Python-logo-notext.svg.png";
    const catalogPdf = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"; // Placeholder

    return {
        welcome_image: welcomeImage,
        catalog_pdf: catalogPdf,
        store_url: "http://localhost:5173" // TODO: Deploy frontend to Vercel/Netlify for public access
    };
}


