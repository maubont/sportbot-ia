import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { colorHex, colorLabel } from '../lib/colors';

interface FilterSidebarProps {
    brands: string[];
    categories: string[];
    availableColors: string[];
    availableSizes: number[];
    selectedCategory: string;
    selectedBrands: string[];
    selectedColors: string[];
    selectedSize: number | null;
    priceMax: number;
    stockOnly: boolean;
    onCategoryChange: (category: string) => void;
    onBrandToggle: (brand: string) => void;
    onColorToggle: (color: string) => void;
    onColorClear: () => void;
    onSizeChange: (size: number | null) => void;
    onPriceMaxChange: (value: number) => void;
    onStockOnlyChange: (value: boolean) => void;
    onClear: () => void;
}

function formatPrice(value: number) {
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        maximumFractionDigits: 0,
    }).format(value);
}

export function FilterSidebar({
    brands,
    categories,
    availableColors,
    availableSizes,
    selectedCategory,
    selectedBrands,
    selectedColors,
    selectedSize,
    priceMax,
    stockOnly,
    onCategoryChange,
    onBrandToggle,
    onColorToggle,
    onColorClear,
    onSizeChange,
    onPriceMaxChange,
    onStockOnlyChange,
    onClear,
}: FilterSidebarProps) {
    // En móvil los filtros ocupan más de una pantalla antes del primer producto.
    // Se pliegan por defecto; en escritorio la barra lateral siempre está abierta.
    const [open, setOpen] = useState(false);

    const activeCount =
        selectedBrands.length +
        selectedColors.length +
        (selectedCategory !== 'Todos' ? 1 : 0) +
        (selectedSize !== null ? 1 : 0) +
        (priceMax < 1000000 ? 1 : 0) +
        (stockOnly ? 0 : 1);

    return (
        <aside className="h-fit min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:sticky lg:top-24">
            <div className="mb-4 flex items-center justify-between gap-3 pr-14 lg:pr-0">
                <div>
                    <h3 className="text-base font-black text-slate-950">Filtros</h3>
                    <p className="hidden text-xs font-medium text-slate-500 lg:block">Inventario conectado</p>
                    <p className="text-xs font-medium text-slate-500 lg:hidden">
                        {activeCount > 0 ? `${activeCount} filtro${activeCount === 1 ? '' : 's'} activo${activeCount === 1 ? '' : 's'}` : 'Marca, color, talla y precio'}
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={onClear}
                        className="rounded-lg px-2 py-1 text-xs font-black text-slate-500 transition hover:bg-slate-100 hover:text-slate-950"
                    >
                        Limpiar
                    </button>
                    <button
                        type="button"
                        onClick={() => setOpen((value) => !value)}
                        aria-expanded={open}
                        aria-controls="filter-sections"
                        className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-slate-950 px-3 text-xs font-black text-white transition hover:bg-slate-800 lg:hidden"
                    >
                        {open ? 'Ocultar' : 'Abrir'}
                        <ChevronDown
                            size={15}
                            aria-hidden="true"
                            className={`transition ${open ? 'rotate-180' : ''}`}
                        />
                    </button>
                </div>
            </div>

            <div id="filter-sections" className={`${open ? 'space-y-6' : 'hidden'} lg:block lg:space-y-6`}>
                <section>
                    <h4 className="mb-3 text-xs font-black uppercase tracking-wide text-slate-400">Categoría</h4>
                    <div className="flex flex-wrap gap-2 lg:flex-col">
                        {categories.map((category) => (
                            <button
                                key={category}
                                type="button"
                                onClick={() => onCategoryChange(category)}
                                className={`flex min-h-10 items-center justify-between rounded-xl px-3 text-sm font-bold transition ${
                                    selectedCategory === category
                                        ? 'bg-slate-950 text-white'
                                        : 'bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                                }`}
                            >
                                <span>{category === 'Todos' ? 'Todo el catálogo' : category}</span>
                                {selectedCategory === category && <Check size={17} aria-hidden="true" />}
                            </button>
                        ))}
                    </div>
                </section>

                <section>
                    <h4 className="mb-3 text-xs font-black uppercase tracking-wide text-slate-400">Marca</h4>
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                        {brands.map((brand) => (
                            <label key={brand} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-slate-50 px-3 text-sm font-bold text-slate-600 transition hover:bg-slate-100 hover:text-slate-950">
                                <input
                                    type="checkbox"
                                    checked={selectedBrands.includes(brand)}
                                    onChange={() => onBrandToggle(brand)}
                                    className="h-4 w-4 rounded border-slate-300 accent-emerald-500"
                                />
                                {brand}
                            </label>
                        ))}
                    </div>
                </section>

                <section>
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <h4 className="text-xs font-black uppercase tracking-wide text-slate-400">Color</h4>
                        {selectedColors.length > 0 && (
                            <button
                                type="button"
                                onClick={onColorClear}
                                className="text-[11px] font-black text-slate-400 transition hover:text-slate-950"
                            >
                                Quitar
                            </button>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                        {availableColors.map((color) => {
                            const selected = selectedColors.includes(color);
                            return (
                                <button
                                    key={color}
                                    type="button"
                                    onClick={() => onColorToggle(color)}
                                    aria-pressed={selected}
                                    className={`flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm font-bold transition ${
                                        selected
                                            ? 'bg-slate-950 text-white'
                                            : 'bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                                    }`}
                                >
                                    <span
                                        className="h-4 w-4 shrink-0 rounded-full border border-black/10 shadow-inner"
                                        style={{ backgroundColor: colorHex(color) }}
                                        aria-hidden="true"
                                    />
                                    <span className="truncate">{colorLabel(color)}</span>
                                    {selected && <Check size={15} className="ml-auto shrink-0" aria-hidden="true" />}
                                </button>
                            );
                        })}
                    </div>
                </section>

                <section>
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <h4 className="text-xs font-black uppercase tracking-wide text-slate-400">Precio máximo</h4>
                        <span className="text-xs font-black text-slate-700">{formatPrice(priceMax)}</span>
                    </div>
                    <input
                        type="range"
                        min="100000"
                        max="1000000"
                        step="50000"
                        value={priceMax}
                        onChange={(event) => onPriceMaxChange(Number(event.target.value))}
                        className="w-full accent-cyan-500"
                    />
                    <div className="mt-1 flex justify-between text-[11px] font-bold text-slate-400">
                        <span>$100k</span>
                        <span>$1M</span>
                    </div>
                </section>

                <section>
                    <h4 className="mb-3 text-xs font-black uppercase tracking-wide text-slate-400">Talla</h4>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => onSizeChange(null)}
                            className={`h-9 rounded-lg px-3 text-sm font-black transition ${
                                selectedSize === null ? 'bg-slate-950 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                            }`}
                        >
                            Todas
                        </button>
                        {availableSizes.map((size) => (
                            <button
                                key={size}
                                type="button"
                                onClick={() => onSizeChange(size)}
                                className={`h-9 min-w-10 rounded-lg px-2 text-sm font-black transition ${
                                    selectedSize === size ? 'bg-cyan-500 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                                }`}
                            >
                                {size}
                            </button>
                        ))}
                    </div>
                </section>

                <section>
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <input
                            type="checkbox"
                            checked={stockOnly}
                            onChange={(event) => onStockOnlyChange(event.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-slate-300 accent-emerald-500"
                        />
                        <span>
                            <span className="block text-sm font-black text-slate-800">Solo disponibles</span>
                            <span className="block text-xs leading-5 text-slate-500">Oculta modelos sin pares libres para venta.</span>
                        </span>
                    </label>
                </section>
            </div>
        </aside>
    );
}
