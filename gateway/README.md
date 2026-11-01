# Evolution Gateway (desarrollo local)

Este compose es sólo para pruebas locales del canal. Publica la interfaz únicamente en 127.0.0.1; no es una configuración de producción.

## Requisitos

- Docker Compose
- POSTGRES_PASSWORD y AUTHENTICATION_API_KEY configurados en el entorno local. Genera valores aleatorios y no los guardes en Git.

## PowerShell

```powershell
$env:POSTGRES_PASSWORD = '<valor-local-aleatorio>'
$env:AUTHENTICATION_API_KEY = '<valor-local-aleatorio>'
docker compose -f gateway/docker-compose.local.yml up -d
node scripts/smoke-gateway.mjs http://localhost:8080 $env:AUTHENTICATION_API_KEY sportbot
```

## Bash

```sh
export POSTGRES_PASSWORD='<valor-local-aleatorio>'
export AUTHENTICATION_API_KEY='<valor-local-aleatorio>'
docker compose -f gateway/docker-compose.local.yml up -d
```

No captures ni subas payloads de clientes, QR/sesiones de WhatsApp, tokens, API keys o secretos de webhook. Evolution y Twilio no forman parte del MVP público activo; Twilio permanece sólo como código heredado de pruebas.
