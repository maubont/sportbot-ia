-- E3.8 - Eventos del primer filtro del comprobante
--
-- La lista de `conversation_events.event_type` es una whitelist. El abono
-- parcial agrega cinco eventos nuevos; sin esto el INSERT del evento fallaria
-- y se perderia la auditoria y la idempotencia de los avisos.
--
-- No se reabre la lista completa: solo se agregan los valores del camino del
-- dinero que faltaban.

ALTER TABLE public.conversation_events
DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;

ALTER TABLE public.conversation_events
ADD CONSTRAINT conversation_events_event_type_check CHECK (
    event_type IN (
        'message_inbound_received',
        'message_outbound_sent',
        'message_status_updated',
        'audio_transcribed',
        'audio_transcription_failed',
        'customer_greeted',
        'product_search_requested',
        'product_search_results',
        'product_image_requested',
        'product_image_sent',
        'stock_check_requested',
        'stock_available',
        'stock_unavailable',
        'order_details_collected',
        'order_created',
        'payment_link_sent',
        'payment_receipt_received',
        'payment_receipt_prevalidated',
        'payment_shortfall_registered',
        'payment_shortfall_notified',
        'payment_receipt_covered_notified',
        'payment_receipt_unreadable_notified',
        'payment_receipt_notice_skipped',
        'payment_receipt_notice_failed',
        'payment_approved',
        'payment_rejected',
        'payment_expired',
        'payment_decision_notified',
        'payment_decision_notification_failed',
        'dispatch_pending',
        'order_shipped',
        'tracking_sent',
        'order_delivered',
        'delivery_notification_failed',
        'customer_support_requested',
        'return_or_exchange_requested',
        'conversation_scored',
        'handoff_suggested',
        'agent_action_suggested',
        'bot_quality_issue_detected',
        'recovery_opportunity_detected',
        'storefront_handoff_created',
        'storefront_handoff_opened',
        'storefront_handoff_linked',
        'storefront_handoff_unresolved',
        'customer_profile_refresh_requested'
    )
);
