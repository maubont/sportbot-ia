import test from "node:test";
import assert from "node:assert/strict";
import { isTestAllowed, parseTestAllowlist } from "./test-guard.ts";

// Mientras el gateway use un WhatsApp personal, el bot no debe contestarle a
// cualquiera. Estas pruebas fijan el comportamiento del candado, sobre todo el
// caso peligroso: lista mal escrita que se apaga en silencio.

test("sin lista configurada, atiende a todos", () => {
    assert.equal(isTestAllowed("+12025550102", undefined), true);
    assert.equal(isTestAllowed("+12025550102", ""), true);
    assert.equal(isTestAllowed("+12025550102", "   "), true);
});

test("solo atiende a los números de la lista", () => {
    const list = "+12025550102,+12025550106";
    assert.equal(isTestAllowed("+12025550102", list), true);
    assert.equal(isTestAllowed("+12025550106", list), true);
    assert.equal(isTestAllowed("+12025550101", list), false);
});

test("acepta el formato en que llega el mensaje (JID de Baileys)", () => {
    assert.equal(isTestAllowed("12025550102@s.whatsapp.net", "+12025550102"), true);
    // Con sufijo de dispositivo.
    assert.equal(isTestAllowed("12025550102:12@s.whatsapp.net", "+12025550102"), true);
});

test("normaliza espacios, prefijo whatsapp y guiones", () => {
    const list = " whatsapp:+12025550102 ; +12025550106 ";
    assert.deepEqual(parseTestAllowlist(list), ["+12025550102", "+12025550106"]);
    assert.equal(isTestAllowed("+12025550102", list), true);
});

test("una lista sin números válidos bloquea a todos", () => {
    // `2025550102` sin indicativo es ambiguo y canonicalE164 lo rechaza a
    // propósito. Si esto se interpretara como lista vacía, el candado se
    // apagaría y el bot hablaría con todo el mundo.
    assert.equal(isTestAllowed("+12025550102", "2025550102"), false);
    assert.equal(isTestAllowed("+12025550102", "no-es-un-numero"), false);
});

test("un remitente inválido nunca pasa", () => {
    assert.equal(isTestAllowed("desconocido", "+12025550102"), false);
    assert.equal(isTestAllowed("", "+12025550102"), false);
});
