import type { MouseEvent } from 'react';
import { Bot, MessageCircle } from 'lucide-react';
import { storefrontCopy } from '../content/storefrontCopy';
import { colorHex, colorLabel } from '../lib/colors';

interface Product {
    id: string;
    brand: string;
    model: string;
    colorway?: string | null;
    colors: string[];
    category?: string | null;
    price_cents: number;
    media_url: string;
    variants: Array<{ size: number; stock: number; reserved: number }>;
    available_sizes: number[];
    available_units: number;
    is_new: boolean;
}

interface ProductCardProps {
    product: Product;
    buildWhatsAppLink: (product: Product, size?: number, handoffCode?: string) => string;
    onAskAssistant?: (product: Product) => void;
    onWhatsAppHandoff?: (product: Product, size: number | undefined, surface: string) => Promise<string | undefined> | string | undefined;
}

function formatPrice(cents: number) {
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        maximumFractionDigits: 0,
    }).format(cents / 100);
}

function stockLabel(units: number) {
    if (units <= 0) return { label: storefrontCopy.productCard.stockStatus.soldOut, className: 'bg-red-50 text-red-700 border-red-100' };
    if (units <= 2) return { label: storefrontCopy.productCard.stockStatus.lastPairs, className: 'bg-amber-50 text-amber-700 border-amber-100' };
    return { label: storefrontCopy.productCard.stockStatus.available, className: 'bg-emerald-50 text-emerald-700 border-emerald-100' };
}

export function ProductCard({ product, buildWhatsAppLink, onAskAssistant, onWhatsAppHandoff }: ProductCardProps) {
    const stock = stockLabel(product.available_units);
    const primarySize = product.available_sizes[0];
    const productName = `${product.brand} ${product.model}`;

    async function handleWhatsAppClick(event: MouseEvent<HTMLAnchorElement>, size: number | undefined, surface: string) {
        if (!onWhatsAppHandoff) return;

        event.preventDefault();
        const targetWindow = window.open('', '_blank');
        if (targetWindow) targetWindow.opener = null;

        const handoffCode = await onWhatsAppHandoff(product, size, surface);
        const url = buildWhatsAppLink(product, size, handoffCode);

        if (targetWindow) {
            targetWindow.location.href = url;
        } else {
            window.location.assign(url);
        }
    }

    return (
        <article className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-xl">
            <div className="relative aspect-square overflow-hidden bg-slate-100">
                <img
                    src={product.media_url}
                    alt={productName}
                    loading="lazy"
                    className="h-full w-full object-contain p-6 transition duration-500 group-hover:scale-105"
                />

                <div className="absolute left-3 top-3 flex flex-wrap gap-2">
                    {product.is_new && (
                        <span className="rounded-full bg-slate-950 px-2.5 py-1 text-xs font-black text-white">
                            {storefrontCopy.productCard.newLabel}
                        </span>
                    )}
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${stock.className}`}>
                        {stock.label}
                    </span>
                </div>
            </div>

            <div className="space-y-4 p-4">
                <div>
                    <p className="text-xs font-black uppercase tracking-wide text-cyan-600">{product.brand}</p>
                    <h3 className="mt-1 line-clamp-2 min-h-12 text-lg font-black leading-tight text-slate-950">
                        {product.model}
                    </h3>
                    <p className="mt-1 min-h-5 text-sm font-medium text-slate-500">
                        {[product.colorway, product.category].filter(Boolean).join(' · ') || storefrontCopy.productCard.fallbackCategory}
                    </p>
                    {product.colors.length > 0 && (
                        <div
                            className="mt-2 flex items-center gap-1.5"
                            aria-label={`Colores: ${product.colors.map(colorLabel).join(', ')}`}
                        >
                            {product.colors.map((color) => (
                                <span
                                    key={color}
                                    title={colorLabel(color)}
                                    className="h-3.5 w-3.5 rounded-full border border-black/10"
                                    style={{ backgroundColor: colorHex(color) }}
                                />
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex items-end justify-between gap-3">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{storefrontCopy.productCard.priceLabel}</p>
                        <p className="text-xl font-black text-slate-950">{formatPrice(product.price_cents)}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{storefrontCopy.productCard.stockLabel}</p>
                        <p className="text-sm font-black text-slate-700">{product.available_units} pares</p>
                    </div>
                </div>

                <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">{storefrontCopy.productCard.sizesLabel}</p>
                    <div className="flex min-h-9 flex-wrap gap-2">
                        {product.available_sizes.length > 0 ? (
                            product.available_sizes.slice(0, 6).map((size) => (
                                <a
                                    key={size}
                                    href={buildWhatsAppLink(product, size)}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(event) => handleWhatsAppClick(event, size, 'product_size_chip')}
                                    className="flex h-8 min-w-10 items-center justify-center rounded-lg border border-slate-200 px-2 text-sm font-black text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
                                    aria-label={`Consultar ${productName} talla ${size} por WhatsApp`}
                                >
                                    {size}
                                </a>
                            ))
                        ) : (
                            <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-500">
                                {storefrontCopy.productCard.restockLabel}
                            </span>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-[1fr_auto] gap-2">
                    <a
                        href={buildWhatsAppLink(product, primarySize)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => handleWhatsAppClick(event, primarySize, 'product_primary_cta')}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-black text-white transition hover:bg-emerald-600"
                    >
                        <MessageCircle size={18} aria-hidden="true" />
                        {storefrontCopy.productCard.buyCta}
                    </a>
                    <button
                        type="button"
                        onClick={() => onAskAssistant?.(product)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:border-slate-950 hover:text-slate-950"
                        aria-label={`Pedir asesoria sobre ${productName}`}
                        title={storefrontCopy.productCard.adviceTitle}
                    >
                        <Bot size={20} aria-hidden="true" />
                    </button>
                </div>
            </div>
        </article>
    );
}
