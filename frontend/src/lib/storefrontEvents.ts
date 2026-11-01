type StorefrontEventType =
  | 'customer_greeted'
  | 'message_inbound_received'
  | 'product_search_requested'
  | 'product_search_results'
  | 'product_image_requested'
  | 'stock_check_requested'
  | 'stock_available'
  | 'stock_unavailable'
  | 'customer_support_requested'
  | 'handoff_suggested';

interface StorefrontEventPayload {
  event_type: StorefrontEventType;
  intent?:
    | 'greeting'
    | 'product_search'
    | 'product_image'
    | 'size_availability'
    | 'price_question'
    | 'buy_intent'
    | 'shipping_status'
    | 'support'
    | 'unknown';
  funnel_stage?:
    | 'new'
    | 'exploring'
    | 'interested'
    | 'stock_validated'
    | 'blocked_stock'
    | 'ready_to_order'
    | 'support'
    | 'lost';
  product_id?: string;
  size_requested?: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

interface StorefrontHandoffPayload {
  source_surface: string;
  product_id?: string;
  product_brand?: string;
  product_model?: string;
  size_requested?: number;
  intent?:
    | 'product_search'
    | 'buy_intent'
    | 'shipping_status'
    | 'support'
    | 'unknown';
  funnel_stage?:
    | 'interested'
    | 'stock_validated'
    | 'ready_to_order'
    | 'support';
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

interface StorefrontHandoffResult {
  handoffCode: string;
  storefrontSessionId: string;
  expiresAt?: string;
  persisted: boolean;
}

const SESSION_KEY = 'sportbot_storefront_session_id';
const EVENT_BUFFER_KEY = 'sportbot_storefront_events';
const HANDOFF_CACHE_KEY = 'sportbot_storefront_handoffs';
const HANDOFF_REQUEST_TIMEOUT_MS = 6000;
const SUPABASE_FUNCTION_URL = `${String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/storefront_events`;
const SUPABASE_ANON_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '');

function createSessionId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEventId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getSessionId() {
  try {
    const current = window.sessionStorage.getItem(SESSION_KEY);
    if (current) return current;
    const next = createSessionId();
    window.sessionStorage.setItem(SESSION_KEY, next);
    return next;
  } catch {
    return createSessionId();
  }
}

export function getStorefrontSessionId() {
  if (typeof window === 'undefined') return createSessionId();
  return getSessionId();
}

function sanitizeMetadata(metadata: StorefrontEventPayload['metadata'] = {}) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.slice(0, 48), typeof value === 'string' ? value.slice(0, 160) : value])
  );
}

function createHeaders() {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (SUPABASE_ANON_KEY.length > 20) {
    headers.apikey = SUPABASE_ANON_KEY;
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }

  return headers;
}

function canPersistRemotely() {
  return SUPABASE_FUNCTION_URL.startsWith('https://') && !SUPABASE_FUNCTION_URL.includes('YOUR_SUPABASE_URL_HERE');
}

function persistStorefrontEvent(event: Record<string, unknown>) {
  if (!canPersistRemotely()) return;

  void fetch(SUPABASE_FUNCTION_URL, {
    method: 'POST',
    headers: createHeaders(),
    body: JSON.stringify({ events: [event] }),
    keepalive: true,
  }).catch(() => {
    // La vitrina no debe fallar si la telemetria remota esta temporalmente caida.
  });
}

function handoffCacheKey(sessionId: string, payload: StorefrontHandoffPayload) {
  return [
    sessionId,
    payload.source_surface,
    payload.product_id || payload.product_brand || 'general',
    payload.product_model || '',
    payload.size_requested || '',
    payload.intent || 'buy_intent',
  ].join(':');
}

function readCachedHandoff(key: string): StorefrontHandoffResult | null {
  try {
    const cache = JSON.parse(window.sessionStorage.getItem(HANDOFF_CACHE_KEY) || '{}') as Record<string, StorefrontHandoffResult>;
    const cached = cache[key];
    if (!cached?.handoffCode) return null;

    if (cached.expiresAt && new Date(cached.expiresAt).getTime() <= Date.now() + 60_000) return null;

    return cached;
  } catch {
    return null;
  }
}

function writeCachedHandoff(key: string, value: StorefrontHandoffResult) {
  try {
    const cache = JSON.parse(window.sessionStorage.getItem(HANDOFF_CACHE_KEY) || '{}') as Record<string, StorefrontHandoffResult>;
    window.sessionStorage.setItem(HANDOFF_CACHE_KEY, JSON.stringify({ ...cache, [key]: value }));
  } catch {
    // El cache solo evita crear codigos repetidos; no debe afectar el flujo comercial.
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function createStorefrontHandoff(payload: StorefrontHandoffPayload): Promise<StorefrontHandoffResult | null> {
  if (typeof window === 'undefined' || !canPersistRemotely()) return null;

  const storefrontSessionId = getSessionId();
  const dedupeKey = handoffCacheKey(storefrontSessionId, payload);
  const cached = readCachedHandoff(dedupeKey);
  if (cached) return cached;

  try {
    const response = await fetchWithTimeout(
      SUPABASE_FUNCTION_URL,
      {
        method: 'POST',
        headers: createHeaders(),
        body: JSON.stringify({
          handoff: {
            storefront_session_id: storefrontSessionId,
            dedupe_key: dedupeKey,
            source_surface: payload.source_surface,
            product_id: payload.product_id,
            product_brand: payload.product_brand,
            product_model: payload.product_model,
            size_requested: payload.size_requested,
            intent: payload.intent || 'buy_intent',
            funnel_stage: payload.funnel_stage || 'ready_to_order',
            metadata: sanitizeMetadata(payload.metadata),
          },
        }),
      },
      HANDOFF_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) return null;

    const data = await response.json() as {
      handoff_code?: string;
      storefront_session_id?: string;
      expires_at?: string;
      ok?: boolean;
    };

    if (!data.ok || !data.handoff_code) return null;

    const result = {
      handoffCode: data.handoff_code,
      storefrontSessionId: data.storefront_session_id || storefrontSessionId,
      expiresAt: data.expires_at,
      persisted: true,
    };

    writeCachedHandoff(dedupeKey, result);
    return result;
  } catch {
    return null;
  }
}

export function trackStorefrontEvent(payload: StorefrontEventPayload) {
  if (typeof window === 'undefined') return;
  const sessionId = getSessionId();
  const eventId = createEventId();

  const event = {
    event_id: eventId,
    channel: 'storefront_webchat',
    actor_type: 'customer',
    direction: 'inbound',
    source: 'storefront_native_chat_v1',
    occurred_at: new Date().toISOString(),
    storefront_session_id: sessionId,
    dedupe_key: `${sessionId}:${eventId}`,
    ...payload,
    metadata: sanitizeMetadata(payload.metadata),
  };

  try {
    const previous = JSON.parse(window.localStorage.getItem(EVENT_BUFFER_KEY) || '[]') as unknown[];
    window.localStorage.setItem(EVENT_BUFFER_KEY, JSON.stringify([...previous.slice(-39), event]));
    window.dispatchEvent(new CustomEvent('sportbot:storefront-event', { detail: event }));
  } catch {
    window.dispatchEvent(new CustomEvent('sportbot:storefront-event', { detail: event }));
  }

  persistStorefrontEvent(event);
}
