import test from "node:test";
import assert from "node:assert/strict";

import { MAX_TRACKING_URL_LENGTH, validateTrackingUrl } from "./tracking_url.ts";

test("la URL de rastreo es opcional: vacío es válido y se normaliza a cadena vacía", () => {
    assert.deepEqual(validateTrackingUrl(""), { ok: true, url: "" });
    assert.deepEqual(validateTrackingUrl("   "), { ok: true, url: "" });
    assert.deepEqual(validateTrackingUrl(null), { ok: true, url: "" });
    assert.deepEqual(validateTrackingUrl(undefined), { ok: true, url: "" });
});

test("acepta http(s) reales y recorta espacios", () => {
    assert.deepEqual(
        validateTrackingUrl("https://rastreo.servientrega.com/Tracking/Guia/12345"),
        { ok: true, url: "https://rastreo.servientrega.com/Tracking/Guia/12345" },
    );
    assert.deepEqual(
        validateTrackingUrl("  http://coordinadora.com/guia=ABC-001  "),
        { ok: true, url: "http://coordinadora.com/guia=ABC-001" },
    );
    assert.deepEqual(
        validateTrackingUrl("HTTPS://GUIA.Envia.co/123"),
        { ok: true, url: "HTTPS://GUIA.Envia.co/123" },
    );
});

test("rechaza esquemas peligrosos o desconocidos", () => {
    assert.equal(validateTrackingUrl("javascript:alert(1)").ok, false);
    assert.equal(validateTrackingUrl("data:text/html,<script>").ok, false);
    assert.equal(validateTrackingUrl("ftp://archivos.com/guia").ok, false);
    assert.equal(validateTrackingUrl("rastreo.servientrega.com/123").ok, false);
    assert.equal(validateTrackingUrl("https:/sin-doble-barra.com").ok, false);
});

test("rechaza espacios internos, no-texto y exceso de longitud", () => {
    assert.equal(validateTrackingUrl("https://guia.com/ 123").ok, false);
    assert.equal(validateTrackingUrl("https://guia.com/a\nb").ok, false);
    assert.equal(validateTrackingUrl(123).ok, false);
    assert.equal(validateTrackingUrl({ url: "https://x.com" }).ok, false);
    assert.equal(validateTrackingUrl(["https://x.com"]).ok, false);

    assert.equal(validateTrackingUrl(`https://g.com/${"a".repeat(486)}`).ok, true);
    assert.equal(validateTrackingUrl(`https://g.com/${"a".repeat(487)}`).ok, false);
    assert.equal(MAX_TRACKING_URL_LENGTH, 500);
});

test("los errores son legibles y mencionan la regla", () => {
    assert.match(validateTrackingUrl("javascript:x").error, /http/);
    assert.match(validateTrackingUrl("https://a b").error, /espacios/);
    assert.match(validateTrackingUrl(`https://${"a".repeat(600)}`).error, /500/);
    assert.match(validateTrackingUrl(42).error, /texto/);
});
