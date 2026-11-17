import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  Bot,
  ChevronDown,
  MessageCircle,
  Search,
  SearchX,
  Zap,
} from 'lucide-react';
import { FilterSidebar } from './components/FilterSidebar';
import { ProductCard } from './components/ProductCard';
import { StorefrontChat } from './components/StorefrontChat';
import { storefrontCopy } from './content/storefrontCopy';
import { COLOR_ORDER, canonicalColorToken, matchesColors, sortColors } from './lib/colors';
import { createStorefrontHandoff, trackStorefrontEvent } from './lib/storefrontEvents';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import './index.css';

const FALLBACK_WHATSAPP_NUMBER = '14155238886';
const PLACEHOLDER_IMG = 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=900&q=80';
const PRODUCT_FETCH_TIMEOUT_MS = 4500;

interface ProductVariant {
  size: number;
  stock: number;
  reserved: number;
}

interface ProductMedia {
  url: string;
  media_type?: string;
  is_primary?: boolean;
  created_at?: string;
}

interface Product {
  id: string;
  brand: string;
  model: string;
  colorway?: string | null;
  colors: string[];
  category?: string | null;
  description?: string | null;
  price_cents: number;
  created_at?: string | null;
  media_url: string;
  variants: ProductVariant[];
  available_sizes: number[];
  available_units: number;
  is_new: boolean;
}

type SortMode = 'recommended' | 'price_asc' | 'price_desc' | 'stock_desc';

function getWhatsAppNumber() {
  return (import.meta.env.VITE_WHATSAPP_NUMBER || FALLBACK_WHATSAPP_NUMBER).replace(/\D/g, '');
}

function buildWhatsAppLink(message: string) {
  return `https://wa.me/${getWhatsAppNumber()}?text=${encodeURIComponent(message)}`;
}

function buildProductWhatsAppLink(product: Product, size?: number, handoffCode?: string) {
  const sizeText = size ? ` en talla ${size}` : '';
  const codeText = handoffCode ? `\nCodigo web: ${handoffCode}` : '';
  return buildWhatsAppLink(
    `Hola SportBot, vi en la web las ${product.brand} ${product.model}${sizeText}. ` +
      `¿Me confirmas disponibilidad, fotos y el link de pago?${codeText}`
  );
}

function buildGeneralWhatsAppLink(intent: string, handoffCode?: string) {
  const codeText = handoffCode ? `\nCodigo web: ${handoffCode}` : '';
  return buildWhatsAppLink(`Hola SportBot, estoy viendo el catálogo web. ${intent}${codeText}`);
}

function productLabel(product: Product) {
  return `${product.brand} ${product.model}`;
}

function productTelemetryMetadata(product: Product, size?: number) {
  return {
    product: productLabel(product),
    product_brand: product.brand,
    product_model: product.model,
    size: size ?? null,
  };
}

function getAvailableStock(variant: ProductVariant) {
  return Math.max((variant.stock || 0) - (variant.reserved || 0), 0);
}

function getMediaUrl(media: ProductMedia[] = []) {
  const images = media.filter((item) => item.media_type !== 'pdf');
  const sorted = [...images].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  return sorted[0]?.url || PLACEHOLDER_IMG;
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function normalizeProduct(row: {
  id: string;
  brand: string;
  model: string;
  colorway?: string | null;
  colors?: string[] | null;
  category?: string | null;
  description?: string | null;
  price_cents: number;
  created_at?: string | null;
  media?: ProductMedia[] | null;
  variants?: ProductVariant[] | null;
}): Product {
  const variants = row.variants || [];
  const availableSizes = variants
    .filter((variant) => getAvailableStock(variant) > 0)
    .map((variant) => Number(variant.size))
    .sort((a, b) => a - b);

  return {
    id: row.id,
    brand: row.brand,
    model: row.model,
    colorway: row.colorway,
    colors: sortColors(Array.isArray(row.colors) ? row.colors : []),
    category: row.category,
    description: row.description,
    price_cents: row.price_cents,
    created_at: row.created_at,
    media_url: getMediaUrl(row.media || []),
    variants,
    available_sizes: availableSizes,
    available_units: variants.reduce((sum, variant) => sum + getAvailableStock(variant), 0),
    is_new: row.created_at
      ? Date.now() - new Date(row.created_at).getTime() < 14 * 24 * 60 * 60 * 1000
      : false,
  };
}

/**
 * Catálogo de demostración, solo en desarrollo.
 *
 * Se carga con import dinámico y detrás de `import.meta.env.DEV`: así el
 * catálogo falso no viaja en el bundle de producción. En producción, si el
 * inventario está vacío o la consulta falla, la página muestra un estado
 * honesto con salida a WhatsApp. Enseñar modelos que no existen con botón de
 * compra es peor que no mostrar nada.
 */
async function loadDemoProducts(): Promise<Product[]> {
  if (!import.meta.env.DEV) return [];
  const { demoCatalog } = await import('./lib/demoCatalog');
  return demoCatalog.map(normalizeProduct);
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Todos');
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState(1000000);
  const [stockOnly, setStockOnly] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>('recommended');
  const [catalogOffline, setCatalogOffline] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatFocusProduct, setChatFocusProduct] = useState<Product | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchProducts() {
      if (!isSupabaseConfigured) {
        // Sin Supabase configurado: en desarrollo se muestra el catálogo de
        // demostración; en producción, un estado honesto.
        const demo = await loadDemoProducts();
        if (isMounted) {
          setProducts(demo);
          setCatalogOffline(!import.meta.env.DEV);
          setLoading(false);
        }
        return;
      }

      try {
        const { data, error } = await withTimeout(
          supabase
            .from('products')
            .select(`
              id, brand, model, colorway, colors, category, description, price_cents, created_at,
              media:product_media(url, media_type, is_primary, created_at),
              variants:product_variants(size, stock, reserved)
            `)
            .eq('active', true)
            .order('created_at', { ascending: false }),
          PRODUCT_FETCH_TIMEOUT_MS,
          'Product inventory request timed out'
        );

        if (error) throw error;

        const normalized = (data || []).map(normalizeProduct);
        if (isMounted) {
          if (normalized.length > 0) {
            setProducts(normalized);
          } else {
            const demo = await loadDemoProducts();
            if (isMounted) {
              setProducts(demo);
              setCatalogOffline(!import.meta.env.DEV);
            }
          }
        }
      } catch (err) {
        console.error('Error fetching products:', err);
        const demo = await loadDemoProducts();
        if (isMounted) {
          setProducts(demo);
          setCatalogOffline(!import.meta.env.DEV);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchProducts();

    return () => {
      isMounted = false;
    };
  }, []);

  const brands = useMemo(
    () => Array.from(new Set(products.map((product) => product.brand).filter(Boolean))).sort(),
    [products]
  );

  const availableColors = useMemo(() => {
    const present = new Set(products.flatMap((product) => product.colors));
    return COLOR_ORDER.filter((color) => present.has(color));
  }, [products]);

  const categories = useMemo(() => {
    const values = Array.from(new Set(products.map((product) => product.category || 'casual'))).sort();
    return ['Todos', ...values];
  }, [products]);

  const availableSizes = useMemo(
    () => Array.from(new Set(products.flatMap((product) => product.available_sizes))).sort((a, b) => a - b),
    [products]
  );

  const filteredProducts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    // "negras" y "black" no aparecen en el colorway; se llevan al color canónico.
    const termCanonical = canonicalColorToken(term);
    const sizeTerm = Number(term.match(/\d{2}/)?.[0] || NaN);

    const filtered = products.filter((product) => {
      const searchable = `${product.brand} ${product.model} ${product.colorway || ''} ${product.category || ''} ${product.colors.join(' ')}`.toLowerCase();
      const matchesSearch =
        !term ||
        searchable.includes(term) ||
        searchable.includes(termCanonical) ||
        (Number.isFinite(sizeTerm) && product.available_sizes.includes(sizeTerm));
      const matchesCategory = selectedCategory === 'Todos' || (product.category || 'casual') === selectedCategory;
      const matchesBrand = selectedBrands.length === 0 || selectedBrands.includes(product.brand);
      const matchesColor = matchesColors(product.colors, selectedColors);
      const matchesSize = !selectedSize || product.available_sizes.includes(selectedSize);
      const matchesPrice = product.price_cents / 100 <= priceMax;
      const matchesStock = !stockOnly || product.available_units > 0;

      return matchesSearch && matchesCategory && matchesBrand && matchesColor && matchesSize && matchesPrice && matchesStock;
    });

    return filtered.sort((a, b) => {
      if (sortMode === 'price_asc') return a.price_cents - b.price_cents;
      if (sortMode === 'price_desc') return b.price_cents - a.price_cents;
      if (sortMode === 'stock_desc') return b.available_units - a.available_units;
      return Number(b.is_new) - Number(a.is_new) || b.available_units - a.available_units;
    });
  }, [priceMax, products, searchTerm, selectedBrands, selectedCategory, selectedColors, selectedSize, sortMode, stockOnly]);

  const featuredProduct = filteredProducts[0] || products[0];

  function toggleBrand(brand: string) {
    setSelectedBrands((current) =>
      current.includes(brand) ? current.filter((item) => item !== brand) : [...current, brand]
    );
  }

  function toggleColor(color: string) {
    setSelectedColors((current) =>
      current.includes(color) ? current.filter((item) => item !== color) : [...current, color]
    );
  }

  function clearFilters() {
    setSearchTerm('');
    setSelectedCategory('Todos');
    setSelectedBrands([]);
    setSelectedColors([]);
    setSelectedSize(null);
    setPriceMax(1000000);
    setStockOnly(true);
    setSortMode('recommended');
  }

  function openChat(product?: Product) {
    setChatFocusProduct(product || null);
    setChatOpen(true);
  }

  function applyChatSearch(query: string) {
    setSearchTerm(query);
    setSelectedCategory('Todos');
    setSelectedBrands([]);
    setSelectedColors([]);
    setSelectedSize(null);
    setStockOnly(true);
    document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' });
  }

  function trackGeneralWhatsAppHandoff(
    intentText: string,
    surface: string,
    intent: 'product_search' | 'shipping_status' | 'support' = 'product_search',
    handoffCode?: string
  ) {
    trackStorefrontEvent({
      event_type: 'handoff_suggested',
      intent,
      funnel_stage: intent === 'product_search' ? 'interested' : 'support',
      metadata: {
        surface,
        intent_text: intentText,
        handoff_code: handoffCode ?? null,
      },
    });
  }

  function trackProductWhatsAppHandoff(product: Product, size: number | undefined, surface: string, handoffCode?: string) {
    trackStorefrontEvent({
      event_type: 'handoff_suggested',
      intent: 'buy_intent',
      funnel_stage: 'ready_to_order',
      product_id: product.id,
      size_requested: size,
      metadata: {
        surface,
        handoff_code: handoffCode ?? null,
        ...productTelemetryMetadata(product, size),
      },
    });
  }

  function openPendingWhatsAppWindow() {
    const targetWindow = window.open('', '_blank');
    if (targetWindow) targetWindow.opener = null;
    return targetWindow;
  }

  function navigateToWhatsApp(targetWindow: Window | null, url: string) {
    if (targetWindow) {
      targetWindow.location.href = url;
    } else {
      window.location.assign(url);
    }
  }

  async function createGeneralHandoff(
    intentText: string,
    surface: string,
    intent: 'product_search' | 'shipping_status' | 'support' = 'product_search'
  ) {
    const result = await createStorefrontHandoff({
      source_surface: surface,
      intent,
      funnel_stage: intent === 'product_search' ? 'interested' : 'support',
      metadata: {
        intent_text: intentText,
      },
    });
    trackGeneralWhatsAppHandoff(intentText, surface, intent, result?.handoffCode);
    return result?.handoffCode;
  }

  async function createProductHandoff(product: Product, size: number | undefined, surface: string) {
    const result = await createStorefrontHandoff({
      source_surface: surface,
      product_id: product.id,
      product_brand: product.brand,
      product_model: product.model,
      size_requested: size,
      intent: 'buy_intent',
      funnel_stage: 'ready_to_order',
      metadata: productTelemetryMetadata(product, size),
    });
    trackProductWhatsAppHandoff(product, size, surface, result?.handoffCode);
    return result?.handoffCode;
  }

  async function handleGeneralWhatsAppClick(
    event: MouseEvent<HTMLAnchorElement>,
    intentText: string,
    surface: string,
    intent: 'product_search' | 'shipping_status' | 'support' = 'product_search'
  ) {
    event.preventDefault();
    const targetWindow = openPendingWhatsAppWindow();
    const handoffCode = await createGeneralHandoff(intentText, surface, intent);
    navigateToWhatsApp(targetWindow, buildGeneralWhatsAppLink(intentText, handoffCode));
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-950 selection:bg-cyan-500 selection:text-white">
      <nav className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <a href="#catalogo" className="flex items-center gap-3" aria-label="SportBot catalogo">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm">
              <Zap size={22} aria-hidden="true" />
            </span>
            <div>
              <span className="block text-lg font-black">{storefrontCopy.brand.name}</span>
              <span className="hidden text-xs font-medium text-slate-500 sm:block">{storefrontCopy.brand.subtitle}</span>
            </div>
          </a>

          <div className="hidden items-center gap-2 md:flex">
            {categories.slice(0, 5).map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  selectedCategory === category ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                }`}
              >
                {category === 'Todos' ? 'Todo' : category}
              </button>
            ))}
          </div>

          <a
            href={buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.navHelp)}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => handleGeneralWhatsAppClick(event, storefrontCopy.whatsappIntents.navHelp, 'nav_whatsapp')}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-emerald-500 px-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-600 sm:px-4"
          >
            <MessageCircle size={18} aria-hidden="true" />
            <span className="hidden sm:inline">{storefrontCopy.nav.whatsapp}</span>
            <span className="sm:hidden">{storefrontCopy.nav.whatsappShort}</span>
          </a>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <section aria-labelledby="catalog-title">
          <div className="relative min-w-0 overflow-hidden rounded-2xl bg-slate-950 px-6 py-7 text-white shadow-sm sm:px-8">
            <video
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 h-full w-full object-cover opacity-25"
            >
              <source src="/Generación_de_Video_de_Zapatilla_Robótica.mp4" type="video/mp4" />
            </video>
            <div className="relative max-w-3xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cyan-100">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {storefrontCopy.hero.badge}
              </div>
              <h1 id="catalog-title" className="max-w-2xl break-words text-3xl font-black leading-none sm:text-6xl">
                {storefrontCopy.hero.title}
              </h1>
              <p className="mt-5 max-w-2xl break-words text-sm leading-7 text-slate-200 sm:text-base">
                {storefrontCopy.hero.description}
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => openChat(featuredProduct)}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-black text-slate-950 transition hover:bg-cyan-100 sm:w-auto sm:px-6"
                >
                  <Bot size={19} aria-hidden="true" />
                  {storefrontCopy.hero.primaryCta}
                </button>
                <button
                  type="button"
                  onClick={() => document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' })}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-white/25 bg-white/10 px-5 text-sm font-bold text-white transition hover:bg-white/20 sm:w-auto sm:px-6"
                >
                  <ChevronDown size={19} aria-hidden="true" />
                  {storefrontCopy.hero.secondaryCta}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section id="catalogo" className="mt-8 scroll-mt-24">
          <div className="mb-5 flex min-w-0 flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-2xl font-black">{storefrontCopy.catalog.title}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {loading ? storefrontCopy.catalog.loading : `${filteredProducts.length} ${storefrontCopy.catalog.foundSuffix}`}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <label className="relative block min-w-0 sm:w-80">
                <Search
                  size={20}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={storefrontCopy.catalog.searchPlaceholder}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-3 text-sm font-medium outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                />
              </label>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:border-cyan-400 focus:ring-4 focus:ring-cyan-100"
              >
                <option value="recommended">{storefrontCopy.catalog.sort.recommended}</option>
                <option value="stock_desc">{storefrontCopy.catalog.sort.stockDesc}</option>
                <option value="price_asc">{storefrontCopy.catalog.sort.priceAsc}</option>
                <option value="price_desc">{storefrontCopy.catalog.sort.priceDesc}</option>
              </select>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[270px_1fr]">
            <FilterSidebar
              brands={brands}
              categories={categories}
              availableColors={availableColors}
              availableSizes={availableSizes}
              selectedCategory={selectedCategory}
              selectedBrands={selectedBrands}
              selectedColors={selectedColors}
              selectedSize={selectedSize}
              priceMax={priceMax}
              stockOnly={stockOnly}
              onCategoryChange={setSelectedCategory}
              onBrandToggle={toggleBrand}
              onColorToggle={toggleColor}
              onColorClear={() => setSelectedColors([])}
              onSizeChange={setSelectedSize}
              onPriceMaxChange={setPriceMax}
              onStockOnlyChange={setStockOnly}
              onClear={clearFilters}
            />

            <div>
              {loading ? (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="aspect-square rounded-xl bg-slate-100" />
                      <div className="mt-4 h-4 w-2/3 rounded bg-slate-100" />
                      <div className="mt-3 h-4 w-1/2 rounded bg-slate-100" />
                    </div>
                  ))}
                </div>
              ) : filteredProducts.length > 0 ? (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  {filteredProducts.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      buildWhatsAppLink={buildProductWhatsAppLink}
                      onAskAssistant={openChat}
                      onWhatsAppHandoff={createProductHandoff}
                    />
                  ))}
                </div>
              ) : catalogOffline ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
                  <SearchX size={48} className="mx-auto text-slate-300" aria-hidden="true" />
                  <h3 className="mt-3 text-xl font-black">No pudimos cargar el inventario</h3>
                  <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
                    Es un problema nuestro, no tuyo. Escríbenos y te confirmamos disponibilidad,
                    tallas y precios al momento.
                  </p>
                  <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
                    <a
                      href={buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.noResults)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => handleGeneralWhatsAppClick(event, storefrontCopy.whatsappIntents.noResults, 'catalog_offline_whatsapp')}
                      className="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-500 px-4 text-sm font-black text-white transition hover:bg-emerald-600"
                    >
                      {storefrontCopy.emptyState.whatsappCta}
                    </a>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
                  <SearchX size={48} className="mx-auto text-slate-300" aria-hidden="true" />
                  <h3 className="mt-3 text-xl font-black">{storefrontCopy.emptyState.title}</h3>
                  <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
                    {storefrontCopy.emptyState.description}
                  </p>
                  <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
                    >
                      {storefrontCopy.emptyState.clearCta}
                    </button>
                    <a
                      href={buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.noResults)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => handleGeneralWhatsAppClick(event, storefrontCopy.whatsappIntents.noResults, 'empty_state_whatsapp')}
                      className="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-500 px-4 text-sm font-black text-white transition hover:bg-emerald-600"
                    >
                      {storefrontCopy.emptyState.whatsappCta}
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-10 border-t border-slate-200 bg-white px-4 py-8 text-sm text-slate-500 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-black text-slate-950">{storefrontCopy.footer.brand}</p>
            <p>{storefrontCopy.footer.description}</p>
          </div>
          <div className="flex flex-wrap gap-4">
            <a href={buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.shipping)} target="_blank" rel="noreferrer" onClick={(event) => handleGeneralWhatsAppClick(event, storefrontCopy.whatsappIntents.shipping, 'footer_shipping', 'shipping_status')} className="font-semibold hover:text-slate-950">
              {storefrontCopy.footer.shipping}
            </a>
            <a href={buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.payments)} target="_blank" rel="noreferrer" onClick={(event) => handleGeneralWhatsAppClick(event, storefrontCopy.whatsappIntents.payments, 'footer_payments', 'support')} className="font-semibold hover:text-slate-950">
              {storefrontCopy.footer.payments}
            </a>
            <a href={buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.support)} target="_blank" rel="noreferrer" onClick={(event) => handleGeneralWhatsAppClick(event, storefrontCopy.whatsappIntents.support, 'footer_support', 'support')} className="font-semibold hover:text-slate-950">
              {storefrontCopy.footer.support}
            </a>
          </div>
        </div>
      </footer>
      <StorefrontChat
        products={products}
        open={chatOpen}
        focusProduct={chatFocusProduct}
        onOpenChange={setChatOpen}
        onApplySearch={applyChatSearch}
        buildWhatsAppLink={buildProductWhatsAppLink}
        buildGeneralWhatsAppLink={buildGeneralWhatsAppLink}
        onWhatsAppHandoff={createProductHandoff}
      />
    </div>
  );
}
