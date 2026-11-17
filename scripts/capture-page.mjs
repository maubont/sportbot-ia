/**
 * Captura una página con Chrome real, emulando viewport de dispositivo.
 *
 * `chrome --headless --screenshot --window-size=390,...` en Windows no baja de
 * ~500 px de ancho: la página se maqueta a 500 y la imagen sale recortada a 390.
 * Eso produce capturas móviles falsas (texto cortado que en un teléfono real
 * envuelve bien). Este script usa el protocolo de DevTools para emular el
 * viewport de verdad.
 *
 * Uso:
 *   node scripts/capture-page.mjs <url> <salida.png> [ancho] [alto] [movil] [pagina-completa] [js-antes-de-capturar]
 *
 * Ejemplos:
 *   node scripts/capture-page.mjs http://127.0.0.1:5199 out/desktop.png 1440 900 false
 *   node scripts/capture-page.mjs http://127.0.0.1:5199 out/mobile.png 390 844 true
 *   node scripts/capture-page.mjs http://127.0.0.1:5199 out/mobile-top.png 390 844 true false
 *   node scripts/capture-page.mjs http://127.0.0.1:5199 out/negro.png 1440 1000 false true "document.querySelectorAll('button')[...]"
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , url, outPath, widthArg, heightArg, mobileArg, fullPageArg, afterJs] = process.argv;
if (!url || !outPath) {
    console.error("uso: node scripts/capture-page.mjs <url> <salida.png> [ancho] [alto] [movil] [pagina-completa] [js-antes-de-capturar]");
    process.exit(2);
}

const width = Number(widthArg ?? 1440);
const height = Number(heightArg ?? 900);
const mobile = mobileArg === "true";
const fullPage = fullPageArg !== "false";
const port = 9333;

const chromeCandidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const chromePath = chromeCandidates.find((path) => {
    try {
        return requireExists(path);
    } catch {
        return false;
    }
});

function requireExists(path) {
    const { existsSync } = process.getBuiltinModule("node:fs");
    return existsSync(path);
}

if (!chromePath) {
    console.error("no encontré Chrome; pásame la ruta en chromeCandidates");
    process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), "capture-page-"));
const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) return;
        } catch {
            // todavía arrancando
        }
        await sleep(250);
    }
    throw new Error("Chrome no abrió el puerto de depuración");
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        const pending = new Map();
        let nextId = 1;

        const send = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveCall, reject: rejectCall });
            socket.send(JSON.stringify({ id, method, params }));
        });

        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (!message.id) return;
            const call = pending.get(message.id);
            if (!call) return;
            pending.delete(message.id);
            if (message.error) call.reject(new Error(`${message.error.message} (${message.error.code})`));
            else call.resolve(message.result ?? {});
        });

        socket.addEventListener("error", () => reject(new Error("WebSocket de DevTools falló")));
        socket.addEventListener("open", () => resolve({ send, socket }));
    });
}

let client;
try {
    await waitForDevtools();

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
        .then((res) => res.json());

    client = await connect(target.webSocketDebuggerUrl);

    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: mobile ? 2 : 1,
        mobile,
    });
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });

    const loaded = new Promise((resolve) => {
        const onMessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.method === "Page.loadEventFired") {
                client.socket.removeEventListener("message", onMessage);
                resolve();
            }
        };
        client.socket.addEventListener("message", onMessage);
    });

    await client.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(15_000)]);
    // Fuentes, imágenes y el primer render de React.
    await sleep(2500);

    // Las tarjetas usan loading="lazy". Sin recorrer la página, todo lo que
    // queda bajo el pliegue sale en blanco y parece un bug de la landing.
    await client.send("Runtime.evaluate", {
        expression: `(async () => {
            const step = Math.max(200, Math.round(window.innerHeight * 0.8));
            for (let y = 0; y < document.body.scrollHeight; y += step) {
                window.scrollTo(0, y);
                await new Promise((resolve) => setTimeout(resolve, 120));
            }
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise((resolve) => setTimeout(resolve, 400));
            window.scrollTo(0, 0);
            await new Promise((resolve) => setTimeout(resolve, 400));
            const images = [...document.images];
            await Promise.all(images.map((image) => image.complete
                ? Promise.resolve()
                : new Promise((resolve) => {
                    image.addEventListener('load', resolve, { once: true });
                    image.addEventListener('error', resolve, { once: true });
                })));
            return images.filter((image) => !image.complete || image.naturalWidth === 0).length;
        })()`,
        awaitPromise: true,
        returnByValue: true,
    }).then(({ result }) => {
        if (Number(result.value) > 0) {
            console.warn(`aviso: ${result.value} imagen(es) no cargaron`);
        }
    });

    // Estado interactivo (por ejemplo, activar un filtro) antes de capturar.
    if (afterJs) {
        const { exceptionDetails } = await client.send("Runtime.evaluate", {
            expression: afterJs,
            awaitPromise: true,
            returnByValue: true,
        });
        if (exceptionDetails) {
            throw new Error(`el js previo falló: ${exceptionDetails.text}`);
        }
        await sleep(500);
        await client.send("Runtime.evaluate", {
            expression: "window.scrollTo(0, 0)",
            returnByValue: true,
        });
        await sleep(300);
    }

    const { data } = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: fullPage,
    });

    writeFileSync(outPath, Buffer.from(data, "base64"));

    const { result } = await client.send("Runtime.evaluate", {
        expression: "JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })",
        returnByValue: true,
    });
    console.log(`ok ${outPath} ${width}x${height} mobile=${mobile} ${result.value}`);
} catch (err) {
    console.error(String(err));
    process.exitCode = 1;
} finally {
    client?.socket.close();
    chrome.kill();
    await sleep(300);
    try {
        rmSync(profile, { recursive: true, force: true });
    } catch {
        // Windows a veces retiene el perfil; no importa
    }
}
