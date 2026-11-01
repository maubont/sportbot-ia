-- Color como dimensión de filtro del catálogo.
--
-- `colorway` es el nombre comercial ("Panda", "Bred Toe", "Infrared") y no sirve
-- para filtrar: nadie escribe "Panda" cuando quiere unas zapatillas blancas.
-- `colors` guarda el vocabulario corto y estable que sí usa la landing, en
-- español y sin variantes de género.
--
-- El vocabulario es un contrato con `frontend/src/lib/colors.ts`: si se agrega
-- un color, se cambia en los dos lados. El CHECK impide que entren valores
-- sueltos ("Negro", "black", "negras") por la puerta de atrás.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS colors TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.products.colors IS
    'Colores canónicos del producto para filtrar en la landing (vocabulario cerrado).';

ALTER TABLE public.products
    DROP CONSTRAINT IF EXISTS products_colors_vocabulary;

ALTER TABLE public.products
    ADD CONSTRAINT products_colors_vocabulary
    CHECK (
        colors <@ ARRAY[
            'negro', 'blanco', 'gris', 'plata', 'azul', 'rojo', 'verde',
            'amarillo', 'beige', 'rosa', 'morado', 'naranja', 'dorado'
        ]::text[]
    );

-- Filtros por color: contención de arrays, no igualdad.
CREATE INDEX IF NOT EXISTS products_colors_gin
    ON public.products USING GIN (colors);

-- Backfill de los SKU que ya existen. Solo toca filas vacías para no pisar una
-- corrección manual posterior.
UPDATE public.products AS p
SET colors = v.colors
FROM (VALUES
    ('NK-AIR-001', ARRAY['blanco', 'gris', 'rojo']::text[]),
    ('NK-PEG-002', ARRAY['negro', 'blanco']::text[]),
    ('AD-ULT-003', ARRAY['negro']::text[]),
    ('AD-FOR-004', ARRAY['blanco', 'azul']::text[]),
    ('NK-DUN-005', ARRAY['blanco', 'negro']::text[]),
    ('NK-MET-006', ARRAY['gris', 'verde']::text[]),
    ('NB-550-007', ARRAY['blanco', 'verde']::text[]),
    ('PU-VEL-008', ARRAY['plata', 'gris']::text[]),
    ('UA-CUR-009', ARRAY['azul', 'amarillo']::text[]),
    ('NK-JOR-010', ARRAY['negro', 'rojo']::text[])
) AS v(sku, colors)
WHERE p.sku = v.sku
  AND p.colors = '{}'::text[];

NOTIFY pgrst, 'reload schema';
