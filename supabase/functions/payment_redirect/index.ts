import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * El checkout de Wompi quedó fuera del MVP (recaudo manual Nequi/Bre-B).
 * Este endpoint se conserva solo para responder honestamente a enlaces viejos:
 * 410 Gone, sin abrir un checkout que ya no se monitorea.
 */
const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Enlace de pago retirado</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { max-width: 520px; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 1px 3px rgba(15, 23, 42, .08); }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { line-height: 1.6; color: #475569; margin: 0 0 12px; }
    strong { color: #0f172a; }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
  </style>
</head>
<body>
  <main>
    <span class="badge">Enlace retirado</span>
    <h1>Este enlace de pago ya no está activo</h1>
    <p>Cambiamos el método de recaudo a <strong>Nequi / Bre-B</strong>. El checkout anterior ya no se monitorea, así que no realices el pago por ahí.</p>
    <p>Escríbenos por WhatsApp y te enviamos las instrucciones vigentes y la referencia de tu pedido.</p>
  </main>
</body>
</html>`;

serve((req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
            },
        });
    }

    return new Response(html, {
        status: 410,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        },
    });
});
