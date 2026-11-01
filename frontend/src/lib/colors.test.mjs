import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    COLOR_ORDER,
    COLOR_VOCABULARY,
    canonicalColorToken,
    colorHex,
    colorLabel,
    matchesColors,
    sortColors,
} from './colors.ts';

test('el vocabulario no tiene duplicados y el orden lo cubre entero', () => {
    const slugs = Object.keys(COLOR_VOCABULARY);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.deepEqual([...COLOR_ORDER].sort(), [...slugs].sort());
});

test('cada color tiene etiqueta y hex válido', () => {
    for (const slug of COLOR_ORDER) {
        assert.match(colorHex(slug), /^#[0-9a-f]{6}$/i, `hex inválido para ${slug}`);
        assert.ok(colorLabel(slug).length > 2, `etiqueta vacía para ${slug}`);
    }
});

test('un color fuera del vocabulario no rompe la interfaz', () => {
    assert.equal(colorLabel('turquesa'), 'Turquesa');
    assert.equal(colorHex('turquesa'), '#cbd5e1');
});

test('sin selección, todo pasa', () => {
    assert.equal(matchesColors(['negro'], []), true);
    assert.equal(matchesColors([], []), true);
});

test('varios colores seleccionados amplían el resultado, no lo restringen', () => {
    // Quien marca negro y blanco quiere ver cualquiera de los dos.
    assert.equal(matchesColors(['blanco'], ['negro', 'blanco']), true);
    assert.equal(matchesColors(['negro'], ['negro', 'blanco']), true);
    assert.equal(matchesColors(['rojo'], ['negro', 'blanco']), false);
});

test('un producto sin colores no coincide con una selección', () => {
    assert.equal(matchesColors([], ['negro']), false);
});

test('ordenar colores sigue el vocabulario, no el alfabeto', () => {
    assert.deepEqual(sortColors(['rojo', 'blanco', 'negro']), ['negro', 'blanco', 'rojo']);
    // Un color desconocido se va al final en vez de perderse.
    assert.deepEqual(sortColors(['turquesa', 'negro']), ['negro', 'turquesa']);
    assert.deepEqual(sortColors(['zafiro', 'amatista']), ['amatista', 'zafiro']);
});

test('los sinónimos de la gente llevan al color canónico', () => {
    assert.equal(canonicalColorToken('negras'), 'negro');
    assert.equal(canonicalColorToken('black'), 'negro');
    assert.equal(canonicalColorToken('White'), 'blanco', 'no depende de que el llamador normalice');
    assert.equal(canonicalColorToken('grises'), 'gris');
    assert.equal(canonicalColorToken('plateadas'), 'plata');
    assert.equal(canonicalColorToken('volt'), 'verde');
    assert.equal(canonicalColorToken('nike'), 'nike', 'lo que no es color se deja igual');
    assert.equal(canonicalColorToken('Nike'), 'Nike', 'y conserva el original si no lo reconoce');
});
