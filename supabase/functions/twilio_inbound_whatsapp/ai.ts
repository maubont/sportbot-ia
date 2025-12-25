import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import OpenAI from "npm:openai@4";
import { toolsDefinition, searchProducts, checkStock, createOrder, getProductMedia } from "./tools.ts";

const openai = new OpenAI({
    apiKey: Deno.env.get("OPENAI_API_KEY")!,
});

export async function processAIResponse(
    supabase: SupabaseClient,
    conversationId: string,
    customerId: string,
    userMessageContent: string
): Promise<{ text: string; media: string[] }> {
    const { data: settings } = await supabase
        .from("settings")
        .select("llm_provider, store_name")
        .single();

    const systemPrompt = `
Eres el asistente de ventas de ${settings?.store_name || "SportBot"}, una tienda de zapatillas en Colombia.

=== FLUJO OBLIGATORIO ===
1. Cliente pregunta por producto → USA search_products → muestra opciones (menciona tallas)
2. Cliente dice talla → USA check_stock(id: UUID, size: number)
3. check_stock retorna available=true → DI: "✅ Sí tenemos talla X (Y en stock)"
4. Cliente quiere comprar → Pide (Nombre, Ciudad, Dirección)
5. Al recibir datos → USA create_order(cliente, items, datos)
6. create_order retorna exitoso → MUESTRA el link de pago (checkout_url) y confirma el pedido.

=== REGLA ABSOLUTA (LEE ESTO PRIMERO) ===
🚨 Los resultados de check_stock, search_products y create_order son la ÚNICA VERDAD.
🚨 USA EL CAMPO "id" (UUID) de search_products para check_stock y create_order.
🚨 Si create_order fue exitoso, NO vuelvas a preguntar por stock; entrega el link de pago directamente.
🚨 Si check_stock dice available=true → HAY STOCK. PUNTO.

=== MULTIMEDIA (CRÍTICO) ===
- **SIEMPRE** que el usuario diga "ver", "mostrar", "foto", "imagen" o pregunte por un color:
  1. Identifica el ID del producto (búscalo si es necesario con search_products).
  2. **LLAMA INMEDIATAMENTE** a get_product_media(id, 'image').
  3. Tu respuesta DEBE incluir la imagen. No describas el producto sin mostrarlo.

=== COMO INTERPRETAR RESULTADOS ===
- Si check_stock retorna: { available: true, stock: 4, size: 42 }
- Si check_stock retorna: { available: true, stock: 4, size: 42 }
  → RESPONDE: "Sí tenemos la talla 42, hay 4 pares disponibles"
- Si check_stock retorna: { available: false, available_sizes: [40,41,43] }
  → RESPONDE: "No tenemos talla 42, pero tenemos: 40, 41, 43"

=== FORMATO ===
- Precios: price_cents/100 = COP (52000000 → $520.000 COP)
- Tallas: EU
- Emojis: 👟🔥😊
`;

    // Fetch last 15 messages for context
    const { data: history } = await supabase
        .from("messages")
        .select("role, body")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(15);

    // CONTEXT INJECTION
    let lastProductId = "";
    if (history) {
        for (const m of history) {
            if (m.role === 'tool' || m.role === 'assistant') {
                const uuidMatch = m.body?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (uuidMatch) {
                    lastProductId = uuidMatch[0];
                    break;
                }
            }
        }
    }

    let finalSystemPrompt = systemPrompt;
    if (lastProductId) {
        finalSystemPrompt += `\n\n=== CONTEXTO DETECTADO ===\nEl usuario probablemente está hablando del producto ID: ${lastProductId}.\nUSA ESTE ID para check_stock o create_order si no se menciona otro.\n`;
        console.log(`[AI] Injected Context: ${lastProductId}`);
    }

    let messages: any[] = [
        { role: "system", content: finalSystemPrompt },
        ...((history || []).reverse().map((m) => ({
            role: m.role.replace("agent", "assistant"),
            content: m.body || ""
        }))),
        { role: "user", content: userMessageContent },
    ];

    const mediaToOutgoing: string[] = [];
    const startTime = Date.now();
    let iteration = 0;
    const maxIterations = 3;
    const maxDuration = 50000;

    while (iteration < maxIterations) {
        const elapsed = Date.now() - startTime;
        if (elapsed > maxDuration) {
            console.log(`[AI] Timeout approaching (${elapsed}ms), breaking loop.`);
            break;
        }

        iteration++;
        console.log(`[AI] Iteration ${iteration}/${maxIterations} (Elapsed: ${elapsed}ms)`);

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages,
            tools: toolsDefinition,
            tool_choice: "auto",
        });

        const aiMessage = response.choices[0].message;
        messages.push(aiMessage);

        if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
            const finalContent = aiMessage.content || "Intenta de nuevo, por favor.";

            await supabase.from("messages").insert({
                conversation_id: conversationId,
                role: "assistant",
                direction: "outbound",
                body: finalContent,
            });

            return { text: finalContent, media: mediaToOutgoing };
        }

        // Process tool calls
        const toolResults = await Promise.all(aiMessage.tool_calls.map(async (toolCall) => {
            const { name, arguments: argsString } = toolCall.function;
            const args = JSON.parse(argsString);
            console.log(`[Tool] Executing: ${name}`, args);

            let result: any;
            try {
                if (name === "search_products") {
                    result = await searchProducts(supabase, args.query, args.category);
                    if (result && result.products && result.products.length > 0) {
                        const contextBody = `[CONTEXT] Search Results: ${result.products.map((p: any) => `${p.name} (ID: ${p.id})`).join(", ")}`;
                        await supabase.from("messages").insert({
                            conversation_id: conversationId,
                            role: "assistant",
                            direction: "outbound",
                            body: contextBody,
                        });
                    }

                } else if (name === "check_stock") {
                    result = await checkStock(supabase, args.product_id, args.size);
                    if (result && result.product_name) {
                        const contextBody = `[CONTEXT] Checked Stock for: ${result.product_name} (ID: ${args.product_id})`;
                        await supabase.from("messages").insert({
                            conversation_id: conversationId,
                            role: "assistant",
                            direction: "outbound",
                            body: contextBody
                        });
                    }

                } else if (name === "get_product_media") {
                    result = await getProductMedia(supabase, args.product_id, args.type);
                    if (result.media && result.media.length > 0) {
                        const primary = result.media.find((m: any) => m.is_primary) || result.media[0];
                        if (primary.url) mediaToOutgoing.push(primary.url);
                    }

                } else if (name === "create_order") {
                    result = await createOrder(
                        supabase,
                        customerId,
                        args.items,
                        args.shipping_city,
                        args.shipping_address,
                        args.shipping_name
                    );
                } else {
                    result = { error: "Unknown tool" };
                }
            } catch (err: any) {
                console.error(`[Tool] Error in ${name}:`, err.message);
                result = { error: err.message };
            }

            console.log(`[Tool] Result:`, result);
            return {
                role: "tool" as const,
                tool_call_id: toolCall.id,
                content: JSON.stringify(result),
            };
        }));

        messages.push(...toolResults);
    }

    const finalResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: messages,
    });

    const finalContent = finalResponse.choices[0].message.content || "Lo siento, tuve un problema al procesar tu solicitud.";
    await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        direction: "outbound",
        body: finalContent,
    });

    return { text: finalContent, media: mediaToOutgoing };
}
