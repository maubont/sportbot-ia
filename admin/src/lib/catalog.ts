/**
 * Reglas operativas del catálogo en el Admin.
 *
 * El vocabulario de color es un contrato con `frontend/src/lib/colors.ts` y con
 * el CHECK de `products.colors`. Se duplica aquí porque Admin y vitrina son
 * paquetes separados; `catalog.test.mjs` compara ambos lados para que no
 * diverjan en silencio.
 */

export const COLOR_VOCABULARY = {
    negro: { label: 'Negro', hex: '#111827' },
    blanco: { label: 'Blanco', hex: '#f8fafc' },
    gris: { label: 'Gris', hex: '#94a3b8' },
    plata: { label: 'Plata', hex: '#cbd5e1' },
    azul: { label: 'Azul', hex: '#2563eb' },
    rojo: { label: 'Rojo', hex: '#dc2626' },
    verde: { label: 'Verde', hex: '#16a34a' },
    amarillo: { label: 'Amarillo', hex: '#facc15' },
    beige: { label: 'Beige', hex: '#d6c7a1' },
    rosa: { label: 'Rosa', hex: '#f472b6' },
    morado: { label: 'Morado', hex: '#7c3aed' },
    naranja: { label: 'Naranja', hex: '#f97316' },
    dorado: { label: 'Dorado', hex: '#ca8a04' },
} as const;

export type CatalogColor = keyof typeof COLOR_VOCABULARY;

export const COLOR_ORDER: CatalogColor[] = [
    'negro',
    'blanco',
    'gris',
    'plata',
    'azul',
    'rojo',
    'verde',
    'amarillo',
    'beige',
    'rosa',
    'morado',
    'naranja',
    'dorado',
];

export const MAX_ITEM_QUANTITY = 10000;
export const MIN_VARIANT_SIZE = 1;
export const MAX_VARIANT_SIZE = 60;

export function isCatalogColor(value: string): value is CatalogColor {
    return Object.prototype.hasOwnProperty.call(COLOR_VOCABULARY, value);
}

/** Deja solo colores del vocabulario, sin repetir y en el orden de la vitrina. */
export function normalizeColors(values: readonly string[]): CatalogColor[] {
    const unique = new Set(values.filter(isCatalogColor));
    return COLOR_ORDER.filter((color) => unique.has(color));
}

/**
 * Talla de zapato: número positivo hasta 60, en pasos de media talla (42.5).
 * Se rechazan texto, cero, negativos y fracciones que no sean .5.
 */
export function parseVariantSize(raw: string): number | null {
    const value = Number(raw.trim().replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    if (value < MIN_VARIANT_SIZE || value > MAX_VARIANT_SIZE) return null;
    if (!Number.isInteger(value * 2)) return null;
    return value;
}

/** Cantidad de reposición: entero positivo y con un techo operativo. */
export function parseStockQuantity(raw: string, max = MAX_ITEM_QUANTITY): number | null {
    const value = Number(raw.trim());
    if (!Number.isInteger(value)) return null;
    if (value <= 0 || value > max) return null;
    return value;
}

export type ProductDraft = {
    brand: string;
    model: string;
    sku: string;
    price: number;
    cost: number;
    colors: readonly string[];
};

/**
 * Devuelve el primer error legible del formulario, o `null` si puede guardarse.
 * El precio llega en pesos (no centavos); la conversión se hace al guardar.
 */
export function validateProductDraft(draft: ProductDraft): string | null {
    if (!draft.brand.trim()) return "La marca es obligatoria.";
    if (!draft.model.trim()) return "El modelo es obligatorio.";
    if (!draft.sku.trim()) return "El SKU es obligatorio.";
    if (!Number.isFinite(draft.price) || draft.price <= 0) {
        return "El precio debe ser mayor que cero.";
    }
    if (!Number.isFinite(draft.cost) || draft.cost < 0) {
        return "El costo no puede ser negativo.";
    }
    if (!draft.colors.every(isCatalogColor)) {
        return "Hay un color fuera del vocabulario.";
    }
    return null;
}
