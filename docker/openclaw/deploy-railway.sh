#!/usr/bin/env bash
# =============================================================================
# deploy-railway.sh — Despliegue de OpenClaw + Vera en Railway Hobby
# =============================================================================
# Uso: ./deploy-railway.sh
# Requisitos: corepack, pnpm, supabase CLI, railway CLI
# =============================================================================

set -euo pipefail

# Colores para salida
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Verificar que estamos en el directorio correcto
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log_info "=== Iniciando despliegue de Vera en Railway Hobby ==="
log_info "Directorio de trabajo: $ROOT_DIR"

# -----------------------------------------------------------------------------
# 1. Verificar herramientas necesarias
# -----------------------------------------------------------------------------
log_info "Verificando herramientas requeridas..."

for cmd in node corepack supabase railway; do
  if ! command -v "$cmd" &> /dev/null; then
    log_error "No se encuentra '$cmd'. Instálalo antes de continuar."
    exit 1
  fi
done
log_ok "Todas las herramientas están disponibles"

# -----------------------------------------------------------------------------
# 2. Verificar variables de entorno
# -----------------------------------------------------------------------------
log_info "Verificando variables de entorno..."

for var in AGENT_MCP_SECRET TELEGRAM_VERA_BOT_TOKEN OPENAI_API_KEY TELEGRAM_OWNER_ID; do
  if [ -z "${!var:-}" ]; then
    log_error "La variable de entorno '$var' no está definida."
    log_error "  Exporta la variable o agrégala a tu archivo .env"
    exit 1
  fi
done
log_ok "Todas las variables de entorno están definidas"

# -----------------------------------------------------------------------------
# 3. Verificar que estamos en la rama correcta
# -----------------------------------------------------------------------------
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  log_warn "Estás en la rama '$CURRENT_BRANCH', no en 'main'"
  read -p "¿Continuar de todas formas? (s/N): " -r
  if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    log_error "Despliegue cancelado por el usuario"
    exit 1
  fi
fi
log_ok "Rama correcta: $CURRENT_BRANCH"

# -----------------------------------------------------------------------------
# 4. Verificar que no haya cambios sin commitear
# -----------------------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  log_warn "Hay cambios sin commitear en el repositorio"
  git status --short
  read -p "¿Continuar con cambios sin commitear? (s/N): " -r
  if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    log_error "Despliegue cancelado por el usuario"
    exit 1
  fi
fi
log_ok "Repositorio limpio"

# -----------------------------------------------------------------------------
# 5. Construir imagen Docker
# -----------------------------------------------------------------------------
log_info "Construyendo imagen Docker de OpenClaw..."
DOCKER_IMAGE="sportbot/vera-openclaw:$(date +%Y%m%d-%H%M%S)"

docker build \
  --tag "$DOCKER_IMAGE" \
  --file docker/openclaw/Dockerfile \
  .

if [ $? -ne 0 ]; then
  log_error "Error construyendo la imagen Docker"
  exit 1
fi
log_ok "Imagen construida: $DOCKER_IMAGE"

# -----------------------------------------------------------------------------
# 6. Subir imagen a un registro (opcional, si se usa registry privado)
# -----------------------------------------------------------------------------
if [ -n "${DOCKER_REGISTRY:-}" ]; then
  log_info "Subiendo imagen a registro: $DOCKER_REGISTRY"
  docker tag "$DOCKER_IMAGE" "$DOCKER_REGISTRY/$DOCKER_IMAGE"
  docker push "$DOCKER_REGISTRY/$DOCKER_IMAGE"
  log_ok "Imagen subida al registro"
else
  log_warn "No se configuró DOCKER_REGISTRY. Se usará la imagen local."
fi

# -----------------------------------------------------------------------------
# 7. Desplegar en Railway
# -----------------------------------------------------------------------------
log_info "Desplegando en Railway..."

# Verificar que estamos autenticados en Railway
if ! railway whoami &> /dev/null; then
  log_error "No estás autenticado en Railway. Ejecuta 'railway login' primero."
  exit 1
fi
log_ok "Autenticado en Railway"

# Vincular proyecto si no existe
if [ ! -f .railway.toml ]; then
  log_info "Inicializando proyecto Railway..."
  railway init
fi

# Desplegar
railway up --detach

if [ $? -ne 0 ]; then
  log_error "Error desplegando en Railway"
  exit 1
fi
log_ok "Despliegue en Railway completado"

# -----------------------------------------------------------------------------
# 8. Verificar despliegue
# -----------------------------------------------------------------------------
log_info "Verificando despliegue..."
RAILWAY_URL=$(railway domain --service openclaw-gateway 2>/dev/null || echo "")

if [ -n "$RAILWAY_URL" ]; then
  log_info "URL del gateway: https://$RAILWAY_URL"

  # Esperar a que el servicio esté listo
  log_info "Esperando a que el gateway esté disponible..."
  for i in {1..30}; do
    if curl -sf "https://$RAILWAY_URL/healthz" > /dev/null 2>&1; then
      log_ok "Gateway respondiendo en https://$RAILWAY_URL/healthz"
      break
    fi
    sleep 2
  done

  # Verificar MCP
  log_info "Verificando Agent Proxy MCP..."
  if curl -sf "https://$RAILWAY_URL/server/discover" \
    -H "Authorization: Bearer $AGENT_MCP_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"protocolVersion":"2026-07-28"}}}' \
    > /dev/null 2>&1; then
    log_ok "RPC admin_mcp respondiendo correctamente"
  else
    log_warn "El RPC admin_mcp no respondió. Verifica la configuración."
  fi
else
  log_warn "No se pudo obtener la URL del gateway de Railway"
  log_info "Verifica manualmente en el dashboard de Railway"
fi

# -----------------------------------------------------------------------------
# 9. Resumen
# -----------------------------------------------------------------------------
log_info "=========================================="
log_info "  DESPLIEGUE COMPLETADO"
log_info "=========================================="
log_info ""
log_info "Pasos siguientes:"
log_info "  1. Verifica que Vera responda en Telegram"
log_info "  2. Prueba: '¿Qué está pasando hoy?'"
log_info "  3. Prueba una nota de voz"
log_info "  4. Verifica /ai-ops para aprobación humana"
log_info ""
log_info "Logs en Railway: railway logs --service openclaw-gateway"
log_info "=========================================="
