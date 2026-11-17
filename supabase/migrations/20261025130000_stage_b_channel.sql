-- =============================================================================
-- Etapa B · Paso 1: canal agnóstico
--
-- El webhook deja de ser "el webhook de Twilio" y pasa a ser el webhook del
-- canal. Esta migración prepara el terreno sin tocar el camino del dinero:
--
--   1. `messages` guarda de qué canal vino y el id del proveedor, sin fingir
--      que todo es Twilio.
--   2. `customers.phone_e164` deja de guardar "whatsapp:+57..." y pasa a E.164
--      real. Los JIDs de Baileys (`57300...@s.whatsapp.net`) solo pueden
--      correlacionarse contra un teléfono canónico.
--
-- Orden de despliegue: aplicar ANTES de desplegar las funciones.
-- =============================================================================

BEGIN;

-- 1. Identidad de proveedor en los mensajes -----------------------------------

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'twilio',
    ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

COMMENT ON COLUMN public.messages.channel IS
    'Canal de origen/destino: twilio | evolution.';
COMMENT ON COLUMN public.messages.provider_message_id IS
    'Id estable del mensaje en el proveedor. Se usa para dedupe y conciliación.';

UPDATE public.messages
   SET provider_message_id = twilio_message_sid
 WHERE provider_message_id IS NULL
   AND twilio_message_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id
    ON public.messages (channel, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- 2. Teléfono canónico --------------------------------------------------------

-- Twilio entregaba `whatsapp:+12025550102`; el nombre de la columna decía E.164.
-- Se quita el prefijo y el `+` opcional para reconstruir el canónico sin duplicarlo.
UPDATE public.customers
   SET phone_e164 = '+' || regexp_replace(phone_e164, '^whatsapp:\+?', '', 'i')
 WHERE phone_e164 ILIKE 'whatsapp:%';

-- Cinturón de seguridad: la forma canónica queda declarada, pero no se valida
-- contra filas históricas (basura de pruebas) para no bloquear el despliegue.
ALTER TABLE public.customers
    DROP CONSTRAINT IF EXISTS customers_phone_e164_canonical;
ALTER TABLE public.customers
    ADD CONSTRAINT customers_phone_e164_canonical
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[0-9]{8,15}$') NOT VALID;

-- La deduplicación ya es genérica (`inbound_messages.provider`), pero el
-- comentario documentaba solo Twilio.
COMMENT ON COLUMN public.inbound_messages.provider IS
    'Canal de origen del mensaje entrante: twilio | evolution.';

COMMIT;
