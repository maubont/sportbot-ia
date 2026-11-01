import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { Bot, MessageCircle, Send, ShoppingBag, Sparkles, X } from 'lucide-react';
import { storefrontCopy } from '../content/storefrontCopy';
import { canonicalColorToken } from '../lib/colors';
import { trackStorefrontEvent } from '../lib/storefrontEvents';

interface ProductVariant {
  size: number;
  stock: number;
  reserved: number;
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
  media_url: string;
  variants: ProductVariant[];
  available_sizes: number[];
  available_units: number;
  is_new: boolean;
}

interface ChatMessage {
  id: string;
  role: 'bot' | 'user';
  text: string;
  products?: Product[];
  selectedSize?: number;
}

interface StorefrontChatProps {
  products: Product[];
  open: boolean;
  focusProduct?: Product | null;
  onOpenChange: (open: boolean) => void;
  onApplySearch: (query: string) => void;
  buildWhatsAppLink: (product: Product, size?: number, handoffCode?: string) => string;
  buildGeneralWhatsAppLink: (intent: string, handoffCode?: string) => string;
  onWhatsAppHandoff?: (product: Product, size: number | undefined, surface: string) => Promise<string | undefined> | string | undefined;
}

const genericWords = new Set([
  'quiero',
  'ver',
  'buscar',
  'busco',
  'tienes',
  'tenis',
  'zapatillas',
  'zapatos',
  'modelo',
  'modelos',
  'marca',
  'marcas',
  'disponible',
  'disponibles',
  'catalogo',
  'catálogo',
  'para',
  'con',
  'una',
  'unas',
  'los',
  'las',
  'por',
  'favor',
  'talla',
  'tallas',
  'numero',
  'nro',
  'num',
  'menos',
  'hasta',
  'maximo',
  'max',
  'presupuesto',
  'de',
  'mil',
]);

function createMessageId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatPrice(cents: number) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function availableStock(variant: ProductVariant) {
  return Math.max((variant.stock || 0) - (variant.reserved || 0), 0);
}

function productTelemetryMetadata(product: Product, size?: number) {
  return {
    product: `${product.brand} ${product.model}`,
    product_brand: product.brand,
    product_model: product.model,
    size: size ?? null,
  };
}

function extractSize(text: string) {
  const match = text.match(/(?:talla|numero|nro|num)?\s*#?\s*(3[5-9]|4[0-6])\b/);
  return match ? Number(match[1]) : undefined;
}

function isSizeToken(token: string) {
  return /^(?:talla|numero|nro|num)?#?(3[5-9]|4[0-6])$/.test(token);
}

function extractBudgetCents(text: string) {
  const normalized = text.replace(/\s/g, '').toLowerCase();
  const match = normalized.match(/(?:menosde|hasta|maximo|max|presupuesto)?\$?(\d{2,3})(?:[.,]?(\d{3}))?k?/);
  if (!match) return undefined;

  const value = Number(`${match[1]}${match[2] || ''}`);
  if (!Number.isFinite(value) || value < 100) return undefined;
  const pesos = (normalized.includes('k') || normalized.includes('mil') || value < 10000) && !match[2]
    ? value * 1000
    : value;
  return pesos * 100;
}

function productSearchText(product: Product) {
  return normalizeText(
    `${product.brand} ${product.model} ${product.colorway || ''} ${product.category || ''} ${product.description || ''} ${product.colors.join(' ')}`
  );
}

function productName(product: Product) {
  return `${product.brand} ${product.model}`;
}

function productHasSize(product: Product, size: number) {
  return product.available_sizes.some((availableSize) => Number(availableSize) === size);
}

function formatSizes(product: Product) {
  return product.available_sizes.map((size) => Number(size)).join(', ');
}

function hasIntent(text: string, expressions: RegExp[]) {
  return expressions.some((expression) => expression.test(text));
}

function findProducts(products: Product[], input: string) {
  const normalized = normalizeText(input);
  const requestedSize = extractSize(normalized);
  const budgetCents = extractBudgetCents(normalized);
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !genericWords.has(token) && !/^\d+$/.test(token) && !isSizeToken(token))
    .map((token) => canonicalColorToken(token));
  const brandTokens = tokens.filter((token) =>
    products.some((product) => normalizeText(product.brand) === token)
  );

  let results = [...products].filter((product) => product.available_units > 0);

  if (budgetCents) {
    results = results.filter((product) => product.price_cents <= budgetCents);
  }

  if (requestedSize) {
    results = results.filter((product) => productHasSize(product, requestedSize));
  }

  if (brandTokens.length > 0) {
    results = results.filter((product) => brandTokens.includes(normalizeText(product.brand)));
  }

  if (tokens.length > 0) {
    results = results
      .map((product) => {
        const searchable = productSearchText(product);
        const score = tokens.reduce((sum, token) => sum + (searchable.includes(token) ? 1 : 0), 0);
        return { product, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.product.available_units - a.product.available_units)
      .map((item) => item.product);
  } else {
    results.sort((a, b) => b.available_units - a.available_units || a.price_cents - b.price_cents);
  }

  return {
    budgetCents,
    products: results.slice(0, 3),
    requestedSize,
    tokenCount: tokens.length,
  };
}

function buildReply(input: string, products: Product[], activeProduct: Product | null) {
  const normalized = normalizeText(input);
  const search = findProducts(products, input);
  const wantsBuy = hasIntent(normalized, [/\b(comprar|pagar|link|whatsapp|pedido)\b/, /\blo quiero\b/, /\bme lo llevo\b/]);
  const asksSizes = hasIntent(normalized, [/\b(talla|tallas|numero|numeros|disponible|disponibles)\b/]);
  const asksPrice = hasIntent(normalized, [/\b(precio|vale|cuesta|cuanto|valor)\b/]);
  const asksImage = hasIntent(normalized, [/\b(foto|fotos|imagen|imagenes|mostrar|muestra|muestrame)\b/]);
  const asksShipping = hasIntent(normalized, [/\b(envio|envios|entrega|domicilio|ciudad)\b/]);
  const searchedProduct = search.products[0] || null;
  const targetProduct = search.tokenCount > 0 && searchedProduct
    ? searchedProduct
    : activeProduct;

  if (targetProduct && search.requestedSize && !productHasSize(targetProduct, search.requestedSize)) {
    const alternatives = products
      .filter((product) => product.id !== targetProduct.id && productHasSize(product, search.requestedSize || 0) && product.available_units > 0)
      .slice(0, 3);
    return {
      text: storefrontCopy.chat.sizeUnavailable,
      products: alternatives.length > 0 ? alternatives : [targetProduct],
      intent: 'size_availability' as const,
      funnel_stage: 'exploring' as const,
      product: alternatives[0] || targetProduct,
      size: search.requestedSize,
    };
  }

  if (wantsBuy && targetProduct) {
    return {
      text: storefrontCopy.chat.buyHandoff,
      products: [targetProduct],
      intent: 'buy_intent' as const,
      funnel_stage: 'ready_to_order' as const,
      product: targetProduct,
      size: search.requestedSize,
    };
  }

  if (targetProduct && search.requestedSize && productHasSize(targetProduct, search.requestedSize)) {
    return {
      text: `${storefrontCopy.chat.selectedSizeForProductPrefix} ${search.requestedSize} para ${productName(targetProduct)}.`,
      products: [targetProduct],
      intent: 'size_availability' as const,
      funnel_stage: 'stock_validated' as const,
      product: targetProduct,
      size: search.requestedSize,
    };
  }

  if (targetProduct && asksPrice) {
    return {
      text: `${storefrontCopy.chat.pricePrefix} ${formatPrice(targetProduct.price_cents)} para ${productName(targetProduct)}.`,
      products: [targetProduct],
      intent: 'price_question' as const,
      funnel_stage: 'interested' as const,
      product: targetProduct,
      size: undefined,
    };
  }

  if (targetProduct && asksSizes) {
    return {
      text: `${storefrontCopy.chat.sizesPrefix}: ${formatSizes(targetProduct)}.`,
      products: [targetProduct],
      intent: 'size_availability' as const,
      funnel_stage: 'interested' as const,
      product: targetProduct,
      size: undefined,
    };
  }

  if (targetProduct && asksImage) {
    return {
      text: storefrontCopy.chat.imageInfo,
      products: [targetProduct],
      intent: 'product_image' as const,
      funnel_stage: 'interested' as const,
      product: targetProduct,
      size: undefined,
    };
  }

  if (asksShipping) {
    return {
      text: storefrontCopy.chat.shippingInfo,
      products: targetProduct ? [targetProduct] : search.products,
      intent: 'shipping_status' as const,
      funnel_stage: targetProduct ? ('interested' as const) : ('exploring' as const),
      product: targetProduct,
      size: undefined,
    };
  }

  if (search.products.length === 0) {
    return {
      text: storefrontCopy.chat.noMatch,
      products: products.filter((product) => product.available_units > 0).slice(0, 3),
      intent: 'unknown' as const,
      funnel_stage: 'exploring' as const,
      size: search.requestedSize,
    };
  }

  const text = search.requestedSize
    ? storefrontCopy.chat.sizeResults
    : search.tokenCount > 0 || search.budgetCents
      ? storefrontCopy.chat.brandResults
      : storefrontCopy.chat.genericResults;

  return {
    text,
    products: search.products,
    intent: search.requestedSize ? ('size_availability' as const) : ('product_search' as const),
    funnel_stage: search.requestedSize ? ('stock_validated' as const) : ('interested' as const),
    product: search.products[0] || null,
    size: search.requestedSize,
  };
}

function eventTypeForReply(intent: ReturnType<typeof buildReply>['intent'], hasSize: boolean) {
  if (intent === 'product_image') return 'product_image_requested';
  if (intent === 'shipping_status') return 'customer_support_requested';
  if (hasSize) return 'stock_check_requested';
  return 'product_search_requested';
}

export function StorefrontChat({
  products,
  open,
  focusProduct,
  onOpenChange,
  onApplySearch,
  buildWhatsAppLink,
  buildGeneralWhatsAppLink,
  onWhatsAppHandoff,
}: StorefrontChatProps) {
  const [input, setInput] = useState('');
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);
  const [activeSize, setActiveSize] = useState<number | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: createMessageId(),
      role: 'bot',
      text: storefrontCopy.chat.intro,
    },
  ]);

  const availableProducts = useMemo(
    () => products.filter((product) => product.available_units > 0).slice(0, 3),
    [products]
  );
  const contextProduct = activeProduct || focusProduct || null;
  const visibleMessages = useMemo(() => {
    if (!focusProduct || activeProduct || messages.length > 1) return messages;
    return [
      ...messages,
      {
        id: `focus-${focusProduct.id}`,
        role: 'bot' as const,
        text: storefrontCopy.chat.selectedProduct,
        products: [focusProduct],
      },
    ];
  }, [activeProduct, focusProduct, messages]);

  useEffect(() => {
    if (!open) return;
    trackStorefrontEvent({
      event_type: 'customer_greeted',
      intent: 'greeting',
      funnel_stage: 'new',
      metadata: { surface: 'storefront_chat' },
    });
  }, [open]);

  useEffect(() => {
    if (!open || !focusProduct) return;
    trackStorefrontEvent({
      event_type: 'product_search_results',
      intent: 'product_search',
      funnel_stage: 'interested',
      product_id: focusProduct.id,
      metadata: {
        ...productTelemetryMetadata(focusProduct),
        source: 'product_card',
      },
    });
  }, [focusProduct, open]);

  function submitMessage(messageText = input) {
    const text = messageText.trim();
    if (!text) return;

    const reply = buildReply(text, products, contextProduct);
    const nextProduct = reply.product || contextProduct;
    const nextSize = reply.size || (nextProduct?.id === contextProduct?.id ? activeSize : undefined);
    setInput('');
    setMessages((current) => [
      ...current,
      { id: createMessageId(), role: 'user', text },
      {
        id: createMessageId(),
        role: 'bot',
        text: reply.text,
        products: reply.products,
        selectedSize: nextSize,
      },
    ]);
    setActiveProduct(nextProduct);
    setActiveSize(nextSize);

    trackStorefrontEvent({
      event_type: 'message_inbound_received',
      intent: reply.intent,
      funnel_stage: reply.funnel_stage,
      product_id: reply.product?.id,
      size_requested: reply.size,
      metadata: {
        text_preview: text,
        result_count: reply.products.length,
        ...(reply.product ? productTelemetryMetadata(reply.product, reply.size) : {}),
      },
    });
    trackStorefrontEvent({
      event_type: eventTypeForReply(reply.intent, Boolean(reply.size)),
      intent: reply.intent,
      funnel_stage: reply.funnel_stage,
      product_id: reply.product?.id,
      size_requested: reply.size,
      metadata: {
        result_count: reply.products.length,
        ...(reply.product ? productTelemetryMetadata(reply.product, reply.size) : {}),
      },
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitMessage();
  }

  function handleProductSelect(product: Product) {
    setActiveProduct(product);
    setActiveSize(undefined);
    setMessages((current) => [
      ...current,
      { id: createMessageId(), role: 'user', text: `Me interesa ${product.brand} ${product.model}` },
      {
        id: createMessageId(),
        role: 'bot',
        text: storefrontCopy.chat.selectedProduct,
        products: [product],
      },
    ]);
    trackStorefrontEvent({
      event_type: 'product_search_results',
      intent: 'product_search',
      funnel_stage: 'interested',
      product_id: product.id,
      metadata: productTelemetryMetadata(product),
    });
  }

  function handleSizeSelect(product: Product, size: number) {
    const variant = product.variants.find((item) => Number(item.size) === size);
    setActiveProduct(product);
    setActiveSize(size);
    setMessages((current) => [
      ...current,
      { id: createMessageId(), role: 'user', text: `Talla ${size}` },
      {
        id: createMessageId(),
        role: 'bot',
        text: storefrontCopy.chat.selectedSize,
        products: [product],
        selectedSize: size,
      },
    ]);
    trackStorefrontEvent({
      event_type: 'stock_available',
      intent: 'size_availability',
      funnel_stage: 'stock_validated',
      product_id: product.id,
      size_requested: size,
      metadata: {
        ...productTelemetryMetadata(product, size),
        available_units: variant ? availableStock(variant) : null,
      },
    });
  }

  function applyProductSearch(product: Product) {
    onApplySearch(`${product.brand} ${product.model}`);
    onOpenChange(false);
  }

  function handoffLink(product?: Product, size?: number, handoffCode?: string) {
    if (product) return buildWhatsAppLink(product, size, handoffCode);
    return buildGeneralWhatsAppLink(storefrontCopy.whatsappIntents.navHelp, handoffCode);
  }

  function trackHandoff(product?: Product, size?: number) {
    trackStorefrontEvent({
      event_type: 'handoff_suggested',
      intent: 'buy_intent',
      funnel_stage: 'ready_to_order',
      product_id: product?.id,
      size_requested: size,
      metadata: {
        ...(product ? productTelemetryMetadata(product, size) : { product: null }),
        surface: 'storefront_chat',
      },
    });
  }

  async function handleHandoffClick(event: MouseEvent<HTMLAnchorElement>, product?: Product, size?: number) {
    event.preventDefault();
    const targetWindow = window.open('', '_blank');
    if (targetWindow) targetWindow.opener = null;

    const handoffCode = product && onWhatsAppHandoff
      ? await onWhatsAppHandoff(product, size, 'storefront_chat')
      : undefined;

    if (!onWhatsAppHandoff) trackHandoff(product, size);

    const url = handoffLink(product, size, handoffCode);
    if (targetWindow) {
      targetWindow.location.href = url;
    } else {
      window.location.assign(url);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label={storefrontCopy.chat.launcher}
        title={storefrontCopy.chat.launcher}
        className="fixed bottom-5 right-5 z-50 inline-flex h-14 w-14 items-center justify-center rounded-full bg-slate-950 text-white shadow-xl shadow-slate-900/20 transition hover:-translate-y-0.5 hover:bg-slate-800 sm:h-auto sm:min-h-12 sm:w-auto sm:gap-2 sm:px-5"
      >
        <Sparkles size={18} aria-hidden="true" />
        <span className="hidden sm:inline">{storefrontCopy.chat.launcher}</span>
      </button>
    );
  }

  return (
    <section className="fixed inset-x-3 bottom-3 z-50 flex max-h-[82vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 sm:inset-x-auto sm:right-5 sm:w-[26rem]" aria-label={storefrontCopy.chat.title}>
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-white">
            <Bot size={20} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-black text-slate-950">{storefrontCopy.chat.title}</h2>
            <p className="text-xs font-semibold text-emerald-600">{storefrontCopy.chat.status}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-950"
          aria-label={storefrontCopy.chat.closeLabel}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 px-4 py-4">
        {visibleMessages.map((message) => (
          <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : 'space-y-3'}>
            <div
              className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                message.role === 'user'
                  ? 'bg-slate-950 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 shadow-sm'
              }`}
            >
              {message.text}
            </div>

            {message.products && message.products.length > 0 && (
              <div className="space-y-2">
                {message.products.map((product) => {
                  const candidateSize =
                    message.selectedSize || (contextProduct?.id === product.id ? activeSize : undefined);
                  const handoffSize =
                    candidateSize && productHasSize(product, candidateSize) ? candidateSize : undefined;

                  return (
                    <article key={`${message.id}-${product.id}`} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                      <div className="grid grid-cols-[5.5rem_1fr] gap-3 p-3">
                        <img src={product.media_url} alt={`${product.brand} ${product.model}`} className="h-20 w-20 rounded-xl bg-slate-100 object-contain p-2" />
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => handleProductSelect(product)}
                            className="block text-left text-sm font-black leading-tight text-slate-950 hover:text-cyan-700"
                          >
                            {product.brand} {product.model}
                          </button>
                          <p className="mt-1 text-xs font-semibold text-slate-500">{product.colorway || product.category || storefrontCopy.productCard.fallbackCategory}</p>
                          <p className="mt-1 text-sm font-black text-slate-950">{formatPrice(product.price_cents)}</p>
                        </div>
                      </div>
                      <div className="border-t border-slate-100 px-3 pb-3">
                        <div className="mb-3 flex flex-wrap gap-2 pt-3">
                          {product.available_sizes.slice(0, 6).map((size) => (
                            <button
                              key={size}
                              type="button"
                              onClick={() => handleSizeSelect(product, size)}
                              className={`flex h-8 min-w-10 items-center justify-center rounded-lg border px-2 text-sm font-black transition ${
                                contextProduct?.id === product.id && activeSize === size
                                  ? 'border-slate-950 bg-slate-950 text-white'
                                  : 'border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700'
                              }`}
                            >
                              {size}
                            </button>
                          ))}
                        </div>
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                          <a
                            href={handoffLink(product, handoffSize)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => handleHandoffClick(event, product, handoffSize)}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 text-xs font-black text-white transition hover:bg-emerald-600"
                          >
                            <MessageCircle size={16} aria-hidden="true" />
                            {storefrontCopy.chat.productCta}
                          </a>
                          <button
                            type="button"
                            onClick={() => applyProductSearch(product)}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:border-slate-950 hover:text-slate-950"
                            aria-label={`${storefrontCopy.chat.applySearchCta}: ${product.brand} ${product.model}`}
                            title={storefrontCopy.chat.applySearchCta}
                          >
                            <ShoppingBag size={18} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {visibleMessages.length === 1 && availableProducts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {storefrontCopy.chat.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submitMessage(suggestion)}
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-cyan-300 hover:text-cyan-700"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-200 bg-white p-3">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={storefrontCopy.chat.placeholder}
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
        />
        <button
          type="submit"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white transition hover:bg-slate-800"
          aria-label={storefrontCopy.chat.sendLabel}
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
