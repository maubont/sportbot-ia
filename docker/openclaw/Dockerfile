# =============================================================================
# Dockerfile — OpenClaw Gateway para Vera en Railway Hobby
# =============================================================================
# Imagen base: Node.js 20 Alpine (ligera, segura)
FROM node:20-alpine AS base

# Instalar dependencias del sistema para ffmpeg y compilación nativa
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias primero (capa de caché)
COPY package.json package-lock.json* ./

# Instalar dependencias de Node (producción solamente)
RUN npm ci --omit=dev && npm cache clean --force

# Copiar el código fuente de OpenClaw
COPY . .

# Construir el proyecto (compilar TypeScript si aplica)
RUN npm run build 2>/dev/null || true

# Variables de entorno por defecto (se sobrescriben en Railway)
ENV NODE_ENV=production
ENV OPENCLAW_GATEWAY_PORT=18789
ENV OPENCLAW_GATEWAY_HOST=0.0.0.0
ENV OPENCLAW_MODE=agent
ENV OPENCLAW_AGENT_ID=vera
ENV OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace-vera
ENV OPENCLAW_MCP_SERVER_URL=https://hjusliaruysnbelkjwol.supabase.co/functions/v1/agent_mcp
ENV OPENCLAW_MCP_SECRET=${AGENT_MCP_SECRET}
ENV OPENCLAW_TELEGRAM_BOT_TOKEN=${TELEGRAM_VERA_BOT_TOKEN}
ENV OPENCLAW_TTS_PROVIDER=openai
ENV OPENCLAW_TTS_MODEL=gpt-4o-mini-tts
ENV OPENCLAW_TTS_VOICE=coral
ENV OPENCLAW_TTS_AUTO=inbound
ENV OPENCLAW_LOG_LEVEL=info

# Exponer puerto del Gateway
EXPOSE 18789

# Healthcheck (Railway lo usa para saber si el servicio está vivo)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:18789/healthz || exit 1

# Comando de inicio: onboarding + iniciar Gateway
CMD ["node", "dist/index.js", "gateway", "start"]