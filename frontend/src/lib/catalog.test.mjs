/**
 * Conciliación del catálogo.
 *
 * Tres lugares dicen lo mismo y pueden desviarse en silencio:
 *
 * 1. `supabase/seed.sql` — lo que se inserta en una base nueva.
 * 2. `supabase/migrations/20261026120000_product_colors.sql` — el backfill de
 *    colores para una base que ya tenía productos.
 * 3. `demoCatalog.ts` — lo que se ve en la landing de desarrollo.
 *
 * Este test falla si se separan. No valida verdad comercial (precio o stock
 * reales); valida que no haya tres catálogos distintos.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { COLOR_VOCABULARY } from './colors.ts';
import { demoCatalog } from './demoCatalog.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const seedSql = readFileSync(join(repoRoot, 'supabase/seed.sql'), 'utf8');
const migrationSql = readFileSync(
    join(repoRoot, 'supabase/migrations/20261026120000_product_colors.sql'),
    'utf8',
);

function parseSeedProducts(sql) {
    const pattern = /^\('([A-Z]{2}-[A-Z0-9]{3}-\d{3})',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),/gm;
    return [...sql.matchAll(pattern)].map((match) => ({
        sku: match[1],
        brand: match[2],
        model: match[3],
        colorway: match[4],
        category: match[5],
        price_cents: Number(match[6]),
    }));
}

function parseBackfill(sql) {
    const pattern = /^\s*\('([A-Z]{2}-[A-Z0-9]{3}-\d{3})', ARRAY\[([^\]]*)\]::text\[\]\)/gm;
    return new Map(
        [...sql.matchAll(pattern)].map((match) => [
            match[1],
            [...match[2].matchAll(/'([a-z]+)'/g)].map((color) => color[1]),
        ]),
    );
}

function parseVocabularyConstraint(sql) {
    const block = sql.match(/CHECK \(\s*colors <@ ARRAY\[([\s\S]*?)\]::text\[\]\s*\)/);
    assert.ok(block, 'no se encontró el CHECK del vocabulario de color');
    return [...block[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
}

const seedProducts = parseSeedProducts(seedSql);
const backfill = parseBackfill(migrationSql);
const demoBySku = new Map(
    demoCatalog.map((product) => [product.id.replace(/^demo-/, '').toUpperCase(), product]),
);

test('el seed se puede leer y tiene los 10 SKU del catálogo base', () => {
    assert.equal(seedProducts.length, 10, 'cambió el catálogo base: actualiza este test');
    assert.equal(new Set(seedProducts.map((product) => product.sku)).size, 10);
});

test('la semilla y el catálogo de demostración tienen el mismo inventario', () => {
    assert.deepEqual(
        [...demoBySku.keys()].sort(),
        seedProducts.map((product) => product.sku).sort(),
    );
});

test('marca, modelo, colorway, categoría y precio coinciden con el seed', () => {
    for (const seed of seedProducts) {
        const demo = demoBySku.get(seed.sku);
        assert.ok(demo, `falta ${seed.sku} en demoCatalog`);
        assert.equal(demo.brand, seed.brand, `marca de ${seed.sku}`);
        assert.equal(demo.model, seed.model, `modelo de ${seed.sku}`);
        assert.equal(demo.colorway, seed.colorway, `colorway de ${seed.sku}`);
        assert.equal(demo.category, seed.category, `categoría de ${seed.sku}`);
        assert.equal(demo.price_cents, seed.price_cents, `precio de ${seed.sku}`);
    }
});

test('el backfill cubre todos los SKU y no inventa otros', () => {
    const seedSkus = seedProducts.map((product) => product.sku).sort();
    assert.deepEqual([...backfill.keys()].sort(), seedSkus);
});

test('cada SKU tiene los mismos colores en la semilla, la migración y el demo', () => {
    for (const product of demoCatalog) {
        const sku = product.id.replace(/^demo-/, '').toUpperCase();
        assert.deepEqual(
            [...product.colors].sort(),
            [...(backfill.get(sku) ?? [])].sort(),
            `colores de ${sku} desalineados entre demoCatalog y la migración`,
        );
    }
});

test('todos los colores usados existen en el vocabulario', () => {
    const vocabulary = new Set(Object.keys(COLOR_VOCABULARY));
    for (const [sku, colors] of backfill) {
        assert.ok(colors.length > 0, `${sku} quedó sin colores`);
        for (const color of colors) {
            assert.ok(vocabulary.has(color), `${sku} usa un color fuera del vocabulario: ${color}`);
        }
    }
});

test('el CHECK de la base y el vocabulario del frontend son el mismo conjunto', () => {
    assert.deepEqual(
        parseVocabularyConstraint(migrationSql).sort(),
        Object.keys(COLOR_VOCABULARY).sort(),
    );
});

test('cada producto del demo tiene imagen primaria y variantes coherentes', () => {
    for (const product of demoCatalog) {
        assert.equal(product.media.length, 1, `${product.id} debe tener una imagen`);
        assert.equal(product.media[0].is_primary, true);
        assert.match(product.media[0].url, /^\/products\/demo\/[A-Z0-9-]+\.svg$/);
        assert.ok(product.variants.length > 0, `${product.id} sin tallas`);
        assert.ok(
            product.variants.some((variant) => variant.stock > 0),
            `${product.id} sin stock: no se podría comprar`,
        );
        for (const variant of product.variants) {
            assert.ok(variant.stock >= 0, `${product.id} talla ${variant.size} con stock negativo`);
            assert.ok(variant.size >= 34 && variant.size <= 46, `${product.id} talla fuera de rango`);
        }
    }
});
