import { test } from "node:test";
import assert from "node:assert/strict";
import {
    actionEffectSummary,
    actionExecutorLink,
    actionStateExplanation,
    agentActionStageLabel,
} from "./agentActionPresentation.ts";

test("propuesta, aprobación y ejecución describen efectos distintos", () => {
    assert.match(actionStateExplanation("pending_approval", "dispatch_review"), /Solo propuesta/);
    assert.match(actionStateExplanation("approved", "dispatch_review"), /todavía no ejecutada/);
    assert.match(actionStateExplanation("executed", "resolve_active_context"), /no envía mensajes, cobra ni despacha/);
    assert.match(actionStateExplanation("failed", "dispatch_review"), /verifica el resultado/);
    assert.match(actionStateExplanation("rejected", "dispatch_review"), /sin ejecutar/);
});

test("las etiquetas de estado no confunden aprobar con ejecutar", () => {
    assert.equal(agentActionStageLabel("suggested"), "Propuesta");
    assert.equal(agentActionStageLabel("pending_approval"), "Pendiente de aprobación");
    assert.equal(agentActionStageLabel("approved"), "Aprobada · sin ejecutar");
    assert.equal(agentActionStageLabel("executed"), "Ejecutada");
    assert.equal(agentActionStageLabel("failed"), "Falló");
});

test("el efecto real responde si algo cambió para el cliente", () => {
    assert.match(actionEffectSummary("pending_approval"), /Ninguno: es solo una propuesta/);
    assert.match(actionEffectSummary("approved"), /Ninguno todavía/);
    assert.match(actionEffectSummary("rejected"), /Ninguno: cerrada sin ejecutar/);
    assert.match(actionEffectSummary("executed", { customer_facing_effect: "none" }), /no cambió nada visible/);
    assert.match(actionEffectSummary("executed", {}), /revisa el resultado/);
});

test("las propuestas enlazan la pantalla operativa y no simulan ejecuciones", () => {
    assert.equal(actionExecutorLink("dispatch_review")?.to, "/logistics");
    assert.equal(actionExecutorLink("notification_retry_review")?.to, "/logistics");
    assert.equal(actionExecutorLink("margin_data_review")?.to, "/orders");
    assert.equal(actionExecutorLink("inventory_alert_review")?.to, "/inventory");
    assert.equal(actionExecutorLink("draft_customer_reply")?.to, "/inbox");
    assert.equal(actionExecutorLink("resolve_active_context"), null);
});
