/**
 * Genera las ilustraciones del catálogo de demostración.
 *
 * No son fotos: son las tres siluetas que ya existían (Air Max, Jordan, Ultraboost)
 * recoloreadas según el colorway de cada producto. Así el catálogo de local es
 * coherente —un Dunk "Panda" se ve blanco y negro— sin inventar fotos de modelos
 * que no son.
 *
 * Uso:
 *   node --experimental-strip-types scripts/generate-demo-art.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoCatalog } from "../frontend/src/lib/demoCatalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "frontend/public/products");
const outDir = join(sourceDir, "demo");

const COLOR_HEX = {
    negro: "#111827",
    blanco: "#f1f5f9",
    gris: "#94a3b8",
    plata: "#cbd5e1",
    azul: "#2563eb",
    rojo: "#dc2626",
    verde: "#16a34a",
    amarillo: "#facc15",
    beige: "#d6c7a1",
    rosa: "#f472b6",
    morado: "#7c3aed",
    naranja: "#f97316",
    dorado: "#ca8a04",
};

// El primer color presente se usa como acento de la silueta.
const ACCENT_PRIORITY = [
    "rojo", "azul", "verde", "amarillo", "naranja", "morado", "rosa",
    "dorado", "negro", "plata", "gris", "beige", "blanco",
];

const SILHOUETTES = {
    airmax: {
        file: "air-max-90.svg",
        accent: "#ef4444",
        blobs: { "#dbeafe": 0, "#fee2e2": 1 },
    },
    jordan: {
        file: "jordan-low.svg",
        accent: "#e2e8f0",
        blobs: { "#e0f2fe": 0, "#e2e8f0": 1 },
    },
    ultraboost: {
        file: "ultraboost-light.svg",
        accent: "#14b8a6",
        blobs: { "#ccfbf1": 0, "#dbeafe": 1 },
    },
};

function mix(hex, withHex, amount) {
    const parse = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    const [r1, g1, b1] = parse(hex);
    const [r2, g2, b2] = parse(withHex);
    const channel = (a, b) => Math.round(a + (b - a) * amount).toString(16).padStart(2, "0");
    return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

function silhouetteFor(product, sku) {
    if (product.category === "running") return SILHOUETTES.ultraboost;
    if (["NK-DUN-005", "AD-FOR-004", "NB-550-007", "UA-CUR-009", "NK-JOR-010"].includes(sku)) {
        return SILHOUETTES.jordan;
    }
    return SILHOUETTES.airmax;
}

function accentFor(colors) {
    const color = ACCENT_PRIORITY.find((candidate) => colors.includes(candidate)) ?? "gris";
    return COLOR_HEX[color] ?? COLOR_HEX.gris;
}

function build(product) {
    const sku = product.id.replace(/^demo-/, "").toUpperCase();
    const silhouette = silhouetteFor(product, sku);
    const accent = accentFor(product.colors);
    const blobA = mix(accent, "#ffffff", 0.88);
    const blobB = mix(accent, "#ffffff", 0.8);
    const background = mix(accent, "#ffffff", 0.94);
    const blobs = [blobA, blobB];

    const base = readFileSync(join(sourceDir, silhouette.file), "utf8");
    const label = `${product.brand} ${product.model} ${product.colorway}`.replace(/"/g, "");

    const svg = base
        .split("\n")
        .map((line) => {
            if (line.includes("<rect")) {
                return line.replace(/fill="#[0-9a-fA-F]{6}"/, `fill="${background}"`);
            }
            if (line.includes("<circle")) {
                return line.replace(/fill="#[0-9a-fA-F]{6}"/g, (match) => {
                    const index = silhouette.blobs[match.slice(7, -1).toLowerCase()];
                    return index === undefined ? match : `fill="${blobs[index]}"`;
                });
            }
            if (line.includes("<path")) {
                return line.replace(
                    new RegExp(silhouette.accent, "gi"),
                    accent,
                );
            }
            if (line.includes("aria-label=")) {
                return line.replace(/aria-label="[^"]*"/, `aria-label="${label}"`);
            }
            return line;
        })
        .join("\n");

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${sku}.svg`), svg);
    return `${sku}.svg`;
}

const generated = demoCatalog.map((product) => build(product));
console.log(`ok: ${generated.length} ilustraciones en frontend/public/products/demo`);
console.log(generated.join(", "));
