-- Document the runtime idempotency contract without rewriting the historical
-- Stage A migration. The unique key is derived from customer, conversation,
-- and the provider's stable inbound-message ID (not cart contents).
COMMENT ON COLUMN public.orders.idempotency_key IS
    'SHA-256 de cliente, conversación e ID estable del mensaje entrante del proveedor. Deduplica redeliveries/reintentos del mismo evento y permite pedidos idénticos desde un mensaje nuevo.';
