import test from "node:test";
import assert from "node:assert/strict";

import { hmacSha1Base64, timingSafeEqual, verifyTwilioSignature } from "./signature.ts";

test("rejects Twilio webhooks when auth token is missing", async () => {
    const req = new Request("https://example.supabase.co/functions/v1/twilio_inbound_whatsapp", {
        method: "POST",
        headers: {
            "x-twilio-signature": "anything",
        },
    });

    const valid = await verifyTwilioSignature(req, { Body: "Hola" }, { authToken: "" });

    assert.equal(valid, false);
});

test("rejects Twilio webhooks without signature header", async () => {
    const req = new Request("https://example.supabase.co/functions/v1/twilio_inbound_whatsapp", {
        method: "POST",
    });

    const valid = await verifyTwilioSignature(req, { Body: "Hola" }, { authToken: "secret" });

    assert.equal(valid, false);
});

test("accepts a valid Twilio signature for the request URL and sorted payload", async () => {
    const authToken = "secret";
    const url = "https://example.supabase.co/functions/v1/twilio_inbound_whatsapp";
    const payload = { From: "whatsapp:+12025550101", Body: "Hola" };
    const sortedPayload = "BodyHolaFromwhatsapp:+12025550101";
    const signature = await hmacSha1Base64(authToken, `${url}${sortedPayload}`);

    const req = new Request(url, {
        method: "POST",
        headers: {
            "x-twilio-signature": signature,
        },
    });

    const valid = await verifyTwilioSignature(req, payload, { authToken });

    assert.equal(valid, true);
});

test("uses constant-time comparison semantics for equal length strings", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
});
