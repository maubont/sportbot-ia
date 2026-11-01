import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
    applyPatch,
    canTransition,
    defaultState,
    isBotPaused,
    rowToState,
    statePromptBlock,
    stateToRow,
    type ConversationState,
    type ConversationStatePatch,
} from "./state-core.ts";

export {
    applyPatch,
    canTransition,
    defaultState,
    isBotPaused,
    rowToState,
    statePromptBlock,
    stateToRow,
};
export type { ConversationState, ConversationStatePatch };

/**
 * Lee el estado de la conversación. Si no existe, devuelve el estado por
 * defecto SIN escribir: la primera escritura ocurre cuando hay un hecho real
 * (producto activo, pedido, handoff).
 */
export async function loadConversationState(
    supabase: SupabaseClient,
    conversationId: string,
): Promise<ConversationState> {
    const { data, error } = await supabase
        .from("conversation_state")
        .select("*")
        .eq("conversation_id", conversationId)
        .maybeSingle();

    if (error) {
        console.error("[state] load failed:", error.message);
        return defaultState(conversationId);
    }

    return data ? rowToState(data) : defaultState(conversationId);
}

/**
 * Aplica un parche validando la transición de stage.
 * Lanza si la transición es ilegal; el llamador decide si ignora o escala.
 */
export async function patchConversationState(
    supabase: SupabaseClient,
    conversationId: string,
    patch: ConversationStatePatch,
): Promise<ConversationState> {
    const current = await loadConversationState(supabase, conversationId);

    if (patch.stage && !canTransition(current.stage, patch.stage)) {
        throw new Error(
            `INVALID_STAGE_TRANSITION:${current.stage}->${patch.stage}`,
        );
    }

    const next = applyPatch(current, patch);
    const { data, error } = await supabase
        .from("conversation_state")
        .upsert(stateToRow(next), { onConflict: "conversation_id" })
        .select("*")
        .single();

    if (error) {
        console.error("[state] patch failed:", error.message);
        throw new Error(`STATE_PATCH_FAILED:${error.message}`);
    }

    return data ? rowToState(data) : next;
}
