import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_DELIVERY_SLA_HOURS,
    DEFAULT_FULFILLMENT_SLA_HOURS,
    MAX_TRACKING_URL_LENGTH,
    slaOrDefault,
    validateTrackingUrl,
} from "./logistics.ts";

import {
    MAX_TRACKING_URL_LENGTH as SHARED_MAX_TRACKING_URL_LENGTH,
    validateTrackingUrl as sharedValidateTrackingUrl,
} from "../../../supabase/functions/_shared/tracking_url.ts";

test("el Admin re-exporta el mismo contrato que aplica dispatch_order", () => {
    assert.equal(validateTrackingUrl, sharedValidateTrackingUrl);
    assert.equal(MAX_TRACKING_URL_LENGTH, SHARED_MAX_TRACKING_URL_LENGTH);
});

test("el formulario rechaza lo mismo que rechazaría el backend", () => {
    assert.deepEqual(validateTrackingUrl("  https://rastreo.com/guia/1  "), {
        ok: true,
        url: "https://rastreo.com/guia/1",
    });
    assert.equal(validateTrackingUrl("javascript:alert(1)").ok, false);
    assert.equal(validateTrackingUrl("").ok, true);
});

test("los SLA por defecto coinciden con el baseline de settings", () => {
    assert.equal(DEFAULT_FULFILLMENT_SLA_HOURS, 24);
    assert.equal(DEFAULT_DELIVERY_SLA_HOURS, 72);
});

test("slaOrDefault usa el valor configurado cuando es positivo", () => {
    assert.equal(slaOrDefault(24, 999), 24);
    assert.equal(slaOrDefault(48, 24), 48);
    assert.equal(slaOrDefault(1, 24), 1);
});

test("slaOrDefault cae al fallback cuando settings no trae valor usable", () => {
    assert.equal(slaOrDefault(null, 24), 24);
    assert.equal(slaOrDefault(undefined, 72), 72);
    assert.equal(slaOrDefault(0, 72), 72);
    assert.equal(slaOrDefault(-5, 24), 24);
    assert.equal(slaOrDefault(Number.NaN, 24), 24);
    assert.equal(slaOrDefault("24", 24), 24);
    assert.equal(slaOrDefault(Infinity, 72), 72);
});
