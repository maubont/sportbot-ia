# IMPLEMENATION PLAN - SPORTBOT IA (CO)

## Goal Description
Build a WhatsApp Sales System (SportBot IA) for a Colombian sports shoe store, featuring an AI sales agent, multimedia support, Wompi payments, and a React Admin Dashboard.

## Architecture (A1)
### Components
1.  **User (WhatsApp)** <-> **Twilio (Sandbox)** <-> **Supabase Edge Function (`twilio_inbound_whatsapp`)**
2.  **Payment (Wompi)** <-> **Supabase Edge Function (`wompi_events`)**
3.  **Admin User** <-> **React Dashboard (Vite)** <-> **Supabase (Auth, DB, Realtime, Storage)**
4.  **AI Logic**: `twilio_inbound_whatsapp` calls LLM (OpenAI/Gemini) & Tools.

### Data Flow
- **Inbound Message**: User -> Twilio -> Edge Function -> Supabase DB (store message) -> LLM Process -> Response -> Twilio -> User.
- **Order**: LLM detects intent -> Create Order (Draft) -> Generate Wompi Link -> User pays.
- **Payment**: Wompi Webhook -> Edge Function -> Validate -> Update Order (Paid) -> Notify User (WhatsApp).

## Database Schema (A2)
Tables: `products`, `product_variants`, `customers`, `conversations`, `messages`, `media_files`, `orders`, `order_items`, `payments`, `settings`. RLS enabled.

## Edge Functions (A3)
- `twilio_inbound_whatsapp`: Handles messages, transcribed audio, AI logic, and tools.
- `wompi_events`: Handles payment confirmation webhooks.
- `admin_actions`: Helper for admin dashboard specific logic (e.g., manual triggers).

## Admin UI (A4)
- **Stack**: React, Vite, Tailwind, shadcn/ui.
- **Layout**: Sidebar navigation, Main content area.
- **Modules**: Chats (WhatsApp clone), Orders (Management), Inventory (CRUD), Settings.

## Verification Plan

### Automated Tests
- **Unit Tests**:
    - Validate Twilio Signature verification logic.
    - Validate Wompi Checksum generation/validation logic.
    - Test LLM Tool Calling formatting.
    - Run via `deno test` in the functions directory.

### Manual Verification
1.  **Twilio Mock**: Use `curl` to POST to `twilio_inbound_whatsapp` simulating a user message "Hola, quiero tenis Nike". Verify response and DB entry.
2.  **Wompi Mock**: Use `curl` to POST to `wompi_events` with a valid signature. Verify Order/Payment status update.
3.  **UI Walkthrough**:
    - Login to Admin.
    - View arriving messages in Realtime.
    - Send a reply from Admin.
    - Create a product in Inventory.
    - Check Order status change after Wompi mock.
