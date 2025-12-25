# Task List - SPORTBOT IA (CO)

## Phase 1: Planning & Architecture
- [x] Define Architecture & Endpoints (Artifact A1)
- [x] Design Database Schema & RLS (Artifact A2)
- [x] Create Implementation Plan

## Phase 2: Backend (Supabase & Edge Functions)
- [x] Create SQL Schema Script (products, variants, customers, conversations, messages, media, orders, items, payments, settings)
- [x] Create Seed Data Script
- [x] Implement `twilio_inbound_whatsapp` Function
    - [x] Signature validation
    - [x] Message parsing & persistence
    - [ ] Media handling (inbound)
    - [x] AI Logic (Sales Closer System Prompt)
    - [x] Tool calling (search, stock, order, shipping, payment)
- [x] Implement `wompi_events` Function
    - [x] Signature/Checksum validation
    - [x] Payment status updates
    - [x] WhatsApp confirmation webhook
- [x] Implement `admin_actions` Function
- [x] Deploy Edge Functions (Blocked by Auth/Project ID mismatch)

## 🛠️ Inventario & Lógica de Herramientas
- [x] Implementar `searchProducts` sensible al stock
- [x] Implementar `checkStock` con sugerencias de tallas
- [x] Resolver IDs de productos (Slugs → UUIDs)
- [x] Corregir bug de matching para IDs muy cortos (ej: "1")
- [x] Refactorizar `resolveProductId` para mayor precisión

## 🤖 Optimización de IA
- [x] Prompt anti-alucinaciones en español
- [x] Loop de llamadas a herramientas (max 3)
- [x] Resolver timeout en Edge Functions (optimizar latencia)
- [x] Manejar respuestas vacías o fallidas de la IA

## 📁 Fase 3: Multimedia (WhatsApp)
- [x] Crear tabla `product_media` y bucket en Supabase
- [x] Implementar herramienta `get_product_media`
- [x] Integrar envío de imágenes y PDFs en el flujo de venta
- [ ] Soporte para audios (Whisper ya integrado, validar flujo)

## Phase 4: Frontend (Admin Dashboard)
- [x] Initialize React + Vite + Tailwind + shadcn/ui Project
- [x] Setup Supabase Client & Auth
- [x] Implement Dashboard Layout
- [x] Implement Chats View (WhatsApp style)
- [x] Implement Orders View
- [x] Implement Inventory/Products View
- [x] Implement Settings View
- [/] Connect Realtime/Polling

## Phase 5: Verification & Delivery
- [ ] Create Test Scripts (Twilio & Wompi Mocking) (Artifact A5)
- [/] Verify End-to-End Flow
- [ ] Create Deployment Guide (ReadMe)
- [ ] Final Walkthrough (Artifact A6)
