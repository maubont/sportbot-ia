/**
 * Vocabulario de color del catálogo.
 *
 * `colorway` es el nombre comercial ("Panda", "Bred Toe", "Infrared") y no sirve
 * para filtrar: nadie busca "Panda" cuando quiere unas zapatillas blancas. Este
 * módulo traduce a un vocabulario corto y estable, que es lo que se guarda en
 * `products.colors` y lo que ve el cliente en los filtros.
 *
 * Regla: un color por concepto, en español, sin variantes de género
 * ("negro", no "negras"/"negros"). Los sinónimos existen solo para interpretar
 * lo que escribe la gente.
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

export type ColorSlug = keyof typeof COLOR_VOCABULARY;

/** Orden en que se muestran los filtros: neutros primero, luego el resto. */
export const COLOR_ORDER: ColorSlug[] = [
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

/** Etiqueta legible; si llega un color fuera del vocabulario, no se rompe. */
export function colorLabel(slug: string): string {
    return COLOR_VOCABULARY[slug as ColorSlug]?.label ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function colorHex(slug: string): string {
    return COLOR_VOCABULARY[slug as ColorSlug]?.hex ?? '#cbd5e1';
}

/** Ordena los colores de un producto según el vocabulario, no alfabéticamente. */
export function sortColors(colors: string[]): string[] {
    return [...colors].sort((a, b) => {
        const indexA = COLOR_ORDER.indexOf(a as ColorSlug);
        const indexB = COLOR_ORDER.indexOf(b as ColorSlug);
        if (indexA === -1 && indexB === -1) return a.localeCompare(b);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });
}

/**
 * Un producto coincide si comparte **al menos un** color con la selección.
 * Filtrar por varios colores amplía el resultado, no lo restringe: quien marca
 * negro y blanco quiere ver cualquiera de los dos.
 */
export function matchesColors(productColors: string[], selectedColors: string[]): boolean {
    if (selectedColors.length === 0) return true;
    return productColors.some((color) => selectedColors.includes(color));
}

/**
 * Sinónimos que usa la gente al escribir: género, plural y el inglés que traen
 * los colorways ("Core Black", "White/Blue").
 */
const COLOR_SYNONYMS: Record<string, ColorSlug> = {
    negra: 'negro', negras: 'negro', negros: 'negro', black: 'negro',
    blanca: 'blanco', blancas: 'blanco', blancos: 'blanco', white: 'blanco',
    grises: 'gris', gray: 'gris', grey: 'gris',
    plateado: 'plata', plateada: 'plata', plateadas: 'plata', silver: 'plata',
    azules: 'azul', blue: 'azul', navy: 'azul',
    roja: 'rojo', rojas: 'rojo', rojos: 'rojo', red: 'rojo',
    verdes: 'verde', green: 'verde', volt: 'verde',
    amarilla: 'amarillo', amarillas: 'amarillo', yellow: 'amarillo',
    beiges: 'beige',
    rosado: 'rosa', rosadas: 'rosa', rosados: 'rosa', pink: 'rosa',
    morada: 'morado', moradas: 'morado', morados: 'morado', purple: 'morado',
    naranjas: 'naranja', orange: 'naranja',
    dorada: 'dorado', doradas: 'dorado', gold: 'dorado',
};

/** Lleva una palabra suelta al color canónico, o la deja como estaba. */
export function canonicalColorToken(token: string): string {
    return COLOR_SYNONYMS[token.toLowerCase()] ?? token;
}
