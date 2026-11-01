import test from "node:test";
import assert from "node:assert/strict";

import {
    COLOR_ORDER,
    COLOR_VOCABULARY,
    isCatalogColor,
    normalizeColors,
    parseStockQuantity,
    parseVariantSize,
    validateProductDraft,
} from "./catalog.ts";

import {
    COLOR_ORDER as FRONTEND_COLOR_ORDER,
    COLOR_VOCABULARY as FRONTEND_COLOR_VOCABULARY,
} from "../../../frontend/src/lib/colors.ts";

test("el vocabulario del Admin coincide con la vitrina", () => {
    assert.deepEqual(COLOR_ORDER, FRONTEND_COLOR_ORDER);
    assert.deepEqual(COLOR_VOCABULARY, FRONTEND_COLOR_VOCABULARY);
});

test("normaliza colores: filtra desconocidos, deduplica y respeta el orden", () => {
    assert.deepEqual(
        normalizeColors(["rojo", "negro", "rojo", "turquesa", "blanco"]),
        ["negro", "blanco", "rojo"],
    );
    assert.deepEqual(normalizeColors([]), []);
    assert.equal(isCatalogColor("negro"), true);
    assert.equal(isCatalogColor("Negro"), false);
});

test("acepta tallas enteras y medias tallas dentro del rango", () => {
    assert.equal(parseVariantSize("42"), 42);
    assert.equal(parseVariantSize(" 42.5 "), 42.5);
    assert.equal(parseVariantSize("42,5"), 42.5);
    assert.equal(parseVariantSize("1"), 1);
    assert.equal(parseVariantSize("60"), 60);
});

test("rechaza tallas fuera de rango o con fracciones no soportadas", () => {
    assert.equal(parseVariantSize(""), null);
    assert.equal(parseVariantSize("0"), null);
    assert.equal(parseVariantSize("-41"), null);
    assert.equal(parseVariantSize("61"), null);
    assert.equal(parseVariantSize("42.3"), null);
    assert.equal(parseVariantSize("abc"), null);
});

test("acepta cantidades enteras positivas y rechaza el resto", () => {
    assert.equal(parseStockQuantity("1"), 1);
    assert.equal(parseStockQuantity("25"), 25);
    assert.equal(parseStockQuantity("0"), null);
    assert.equal(parseStockQuantity("-2"), null);
    assert.equal(parseStockQuantity("2.5"), null);
    assert.equal(parseStockQuantity("10001"), null);
    assert.equal(parseStockQuantity(""), null);
});

test("valida el formulario de producto", () => {
    const valid = {
        brand: "Nike",
        model: "Air Max 90",
        sku: "NK-AIR-001",
        price: 450000,
        cost: 0,
        colors: ["blanco", "rojo"],
    };
    assert.equal(validateProductDraft(valid), null);

    assert.match(validateProductDraft({ ...valid, brand: " " }), /marca/i);
    assert.match(validateProductDraft({ ...valid, model: "" }), /modelo/i);
    assert.match(validateProductDraft({ ...valid, sku: "" }), /SKU/);
    assert.match(validateProductDraft({ ...valid, price: 0 }), /precio/i);
    assert.match(validateProductDraft({ ...valid, price: Number.NaN }), /precio/i);
    assert.match(validateProductDraft({ ...valid, cost: -1 }), /costo/i);
    assert.match(validateProductDraft({ ...valid, colors: ["turquesa"] }), /color/i);
});
