/**
 * Catálogo de demostración.
 *
 * Es el mismo catálogo de `supabase/seed.sql`: mismos SKU, marcas, precios,
 * colores y tallas. Existe para que la landing se pueda revisar y diseñar sin
 * Supabase levantado, y para que lo que se ve en local corresponda con lo que
 * habrá en la base.
 *
 * **Solo se usa en desarrollo.** En producción, si la consulta falla o el
 * inventario está vacío, la página muestra un estado honesto con salida a
 * WhatsApp: enseñar zapatillas que no existen y un botón de compra es peor que
 * no mostrar nada.
 *
 * Las imágenes son ilustraciones generadas desde el colorway
 * (`scripts/generate-demo-art.mjs`), no fotos. Se reemplazan por las fotos
 * reales de cada producto.
 */

export interface DemoVariant {
    size: number;
    stock: number;
    reserved: number;
}

export interface DemoRow {
    id: string;
    brand: string;
    model: string;
    colorway: string;
    category: string;
    description: string;
    price_cents: number;
    colors: string[];
    created_at: string;
    media: Array<{ url: string; media_type: string; is_primary: boolean; created_at: string }>;
    variants: DemoVariant[];
}

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function variants(entries: Array<[number, number]>): DemoVariant[] {
    return entries.map(([size, stock]) => ({ size, stock, reserved: 0 }));
}

function row(
    sku: string,
    data: Omit<DemoRow, 'id' | 'media' | 'created_at'> & { days_old: number },
): DemoRow {
    const { days_old, ...rest } = data;
    return {
        id: `demo-${sku.toLowerCase()}`,
        ...rest,
        created_at: daysAgo(days_old),
        media: [{
            url: `/products/demo/${sku}.svg`,
            media_type: 'image',
            is_primary: true,
            created_at: daysAgo(days_old),
        }],
    };
}

export const demoCatalog: DemoRow[] = [
    row('NK-AIR-001', {
        brand: 'Nike',
        model: 'Air Max 90',
        colorway: 'Infrared',
        category: 'casual',
        description: 'Clásicas Air Max 90 con diseño atemporal y comodidad superior.',
        price_cents: 45000000,
        colors: ['blanco', 'gris', 'rojo'],
        variants: variants([[39, 5], [40, 8], [41, 0], [42, 3]]),
        days_old: 45,
    }),
    row('NK-PEG-002', {
        brand: 'Nike',
        model: 'Pegasus 40',
        colorway: 'Black/White',
        category: 'running',
        description: 'Zapatillas de running versátiles con soporte reactivo.',
        price_cents: 52000000,
        colors: ['negro', 'blanco'],
        variants: variants([[38, 5], [39, 10], [40, 10], [41, 4], [42, 6]]),
        days_old: 30,
    }),
    row('AD-ULT-003', {
        brand: 'Adidas',
        model: 'Ultraboost Light',
        colorway: 'Core Black',
        category: 'running',
        description: 'Energía épica. Zapatillas de running ultraligeras.',
        price_cents: 60000000,
        colors: ['negro'],
        variants: variants([[40, 3], [41, 5], [42, 2], [43, 4]]),
        days_old: 60,
    }),
    row('AD-FOR-004', {
        brand: 'Adidas',
        model: 'Forum Low',
        colorway: 'White/Blue',
        category: 'casual',
        description: 'Estilo clásico de baloncesto de los 80.',
        price_cents: 38000000,
        colors: ['blanco', 'azul'],
        variants: variants([[39, 6], [40, 8], [41, 4]]),
        days_old: 22,
    }),
    row('NK-DUN-005', {
        brand: 'Nike',
        model: 'Dunk Low',
        colorway: 'Panda',
        category: 'casual',
        description: 'El icono del baloncesto que domina las calles.',
        price_cents: 48000000,
        colors: ['blanco', 'negro'],
        variants: variants([[40, 20], [41, 20], [42, 15]]),
        days_old: 3,
    }),
    row('NK-MET-006', {
        brand: 'Nike',
        model: 'Metcon 9',
        colorway: 'Grey/Volt',
        category: 'training',
        description: 'Estabilidad y durabilidad para tus entrenamientos de fuerza.',
        price_cents: 55000000,
        colors: ['gris', 'verde'],
        variants: variants([[40, 7], [41, 5], [42, 3], [43, 2]]),
        days_old: 18,
    }),
    row('NB-550-007', {
        brand: 'New Balance',
        model: '550',
        colorway: 'White/Green',
        category: 'casual',
        description: 'El regreso de una leyenda. Estilo retro simple y limpio.',
        price_cents: 42000000,
        colors: ['blanco', 'verde'],
        variants: variants([[39, 4], [40, 6], [41, 5], [42, 3]]),
        days_old: 12,
    }),
    row('PU-VEL-008', {
        brand: 'Puma',
        model: 'Velophasis',
        colorway: 'Silver',
        category: 'casual',
        description: 'Inspiradas en el running de los 2000.',
        price_cents: 39000000,
        colors: ['plata', 'gris'],
        variants: variants([[40, 8], [41, 6], [42, 4]]),
        days_old: 5,
    }),
    row('UA-CUR-009', {
        brand: 'Under Armour',
        model: 'Curry 11',
        colorway: 'Dub Nation',
        category: 'basketball',
        description: 'Control total en la cancha con la tecnología Flow.',
        price_cents: 62000000,
        colors: ['azul', 'amarillo'],
        variants: variants([[41, 3], [42, 5], [43, 4], [44, 2]]),
        days_old: 8,
    }),
    row('NK-JOR-010', {
        brand: 'Jordan',
        model: 'Air Jordan 1 Low',
        colorway: 'Bred Toe',
        category: 'casual',
        description: 'Un pedazo de historia. Siempre frescas.',
        price_cents: 51000000,
        colors: ['negro', 'rojo'],
        variants: variants([[40, 5], [41, 7], [42, 4], [43, 3]]),
        days_old: 40,
    }),
];
