// Captura payloads reales del gateway (desarrollo).
// Uso: node scripts/capture-webhook.mjs [puerto] [archivo-salida]
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 3999);
const out = process.argv[3] ?? "gateway/webhook-capture.log";

writeFileSync(out, "");

const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        const entry = {
            at: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: safeParse(body),
        };

        appendFileSync(out, `${JSON.stringify(entry, null, 2)}\n---\n`);

        const event = entry.headers["x-evolution-event"];
        console.log(`[${event ?? "?"}] ${req.method} ${req.url} (${body.length} bytes)`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
});

function safeParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return text.slice(0, 2000);
    }
}

server.listen(port, () => {
    console.log(`capturando en http://localhost:${port} -> ${out}`);
});
