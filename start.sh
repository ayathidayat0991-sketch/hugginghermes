#!/bin/bash
set -euo pipefail
umask 0077

APP_DIR="${HUGGINGMES_APP_DIR:-/opt/huggingmes}"
HERMES_HOME="${HERMES_HOME:-/opt/data}"
PUBLIC_PORT="${PORT:-7861}"
GATEWAY_API_PORT="${API_SERVER_PORT:-8642}"
DASHBOARD_PORT="${DASHBOARD_PORT:-9119}"
TELEGRAM_WEBHOOK_PORT="${TELEGRAM_WEBHOOK_PORT:-8765}"
SYNC_INTERVAL="${SYNC_INTERVAL:-600}"
BACKUP_DATASET="${BACKUP_DATASET_NAME:-huggingmes-backup}"
CF_PROXY_ENV_FILE="/tmp/huggingmes-cloudflare-proxy.env"

export HERMES_HOME
export API_SERVER_ENABLED="${API_SERVER_ENABLED:-true}"
export API_SERVER_HOST="${API_SERVER_HOST:-127.0.0.1}"
export API_SERVER_PORT="$GATEWAY_API_PORT"
export GATEWAY_HEALTH_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:${GATEWAY_API_PORT}}"
export TELEGRAM_WEBHOOK_PORT
export WHATSAPP_PROVIDER="${WHATSAPP_PROVIDER:-cloud}"
export WHATSAPP_GRAPH_API_VERSION="${WHATSAPP_GRAPH_API_VERSION:-v20.0}"

printf '\n ╔══════════════════════════════════════════╗\n ║ HuggingMes Hermes Gateway                ║\n ╚══════════════════════════════════════════╝\n\n'

if [ -z "${API_SERVER_KEY:-}" ]; then
  if [ -n "${GATEWAY_TOKEN:-}" ]; then
    export API_SERVER_KEY="$GATEWAY_TOKEN"
  else
    API_SERVER_KEY="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
    export API_SERVER_KEY
    echo "GATEWAY_TOKEN not set - generated an ephemeral API token for this boot."
  fi
fi

mkdir -p "$HERMES_HOME"/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home,plugins,whatsapp/baileys}
mkdir -p "$HERMES_HOME/.local/bin"
ln -sfn /opt/hermes/.venv/bin/hermes "$HERMES_HOME/.local/bin/hermes" || true
if [ ! -L "${HOME}/.hermes/plugins" ]; then
  mkdir -p "${HOME}/.hermes"
  rm -rf "${HOME}/.hermes/plugins"
  ln -sfn "$HERMES_HOME/plugins" "${HOME}/.hermes/plugins"
fi

if [ -n "${HF_TOKEN:-}" ]; then
  echo "Restoring Hermes state from HF Dataset..."
  python3 "$APP_DIR/hermes-sync.py" restore || true
else
  echo "HF_TOKEN not set - dataset persistence is disabled."
fi

CLOUDFLARE_WORKERS_TOKEN="${CLOUDFLARE_WORKERS_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
export CLOUDFLARE_WORKERS_TOKEN
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ] || [ -n "${CLOUDFLARE_PROXY_URL:-}" ]; then
  echo "Preparing Cloudflare Telegram proxy..."
  python3 "$APP_DIR/cloudflare-proxy-setup.py" || true
  [ -f "$CF_PROXY_ENV_FILE" ] && . "$CF_PROXY_ENV_FILE"
fi
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
  echo "Preparing Cloudflare Keepalive worker..."
  python3 "$APP_DIR/cloudflare-keepalive-setup.py" || true
fi

if [ -n "${TELEGRAM_USER_IDS:-}" ] && [ -z "${TELEGRAM_ALLOWED_USERS:-}" ]; then
  export TELEGRAM_ALLOWED_USERS="$TELEGRAM_USER_IDS"
elif [ -n "${TELEGRAM_USER_ID:-}" ] && [ -z "${TELEGRAM_ALLOWED_USERS:-}" ]; then
  export TELEGRAM_ALLOWED_USERS="$TELEGRAM_USER_ID"
fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${SPACE_HOST:-}" ] && [ -z "${TELEGRAM_WEBHOOK_URL:-}" ] && [ "${TELEGRAM_MODE:-webhook}" != "polling" ]; then
  export TELEGRAM_WEBHOOK_URL="https://${SPACE_HOST}/telegram"
fi

MODEL_INPUT="${HERMES_MODEL:-${LLM_MODEL:-}}"
MODEL_FOR_CONFIG="$MODEL_INPUT"
PROVIDER_FOR_CONFIG="${HERMES_INFERENCE_PROVIDER:-auto}"
LLM_API_KEY="${LLM_API_KEY:-}"
MODEL_PREFIX="${MODEL_INPUT%%/*}"

case "$MODEL_PREFIX" in
  openrouter) [ -n "$LLM_API_KEY" ] && export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"; [ "$PROVIDER_FOR_CONFIG" = "auto" ] && PROVIDER_FOR_CONFIG="openrouter"; MODEL_FOR_CONFIG="${MODEL_INPUT#openrouter/}" ;;
  huggingface|hf) [ -n "$LLM_API_KEY" ] && export HF_TOKEN="${HF_TOKEN:-$LLM_API_KEY}"; [ "$PROVIDER_FOR_CONFIG" = "auto" ] && PROVIDER_FOR_CONFIG="huggingface"; MODEL_FOR_CONFIG="${MODEL_INPUT#*/}" ;;
  anthropic) [ -n "$LLM_API_KEY" ] && export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}" ;;
  openai|openai-codex) [ -n "$LLM_API_KEY" ] && export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}" ;;
  google|gemini) [ -n "$LLM_API_KEY" ] && export GOOGLE_API_KEY="${GOOGLE_API_KEY:-$LLM_API_KEY}" GEMINI_API_KEY="${GEMINI_API_KEY:-$LLM_API_KEY}"; PROVIDER_FOR_CONFIG="gemini"; MODEL_FOR_CONFIG="${MODEL_INPUT#*/}" ;;
  deepseek) [ -n "$LLM_API_KEY" ] && export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-$LLM_API_KEY}" ;;
  xai|grok) [ -n "$LLM_API_KEY" ] && export XAI_API_KEY="${XAI_API_KEY:-$LLM_API_KEY}" ;;
  *) : ;;
esac
if [ -n "${CUSTOM_BASE_URL:-}" ]; then
  PROVIDER_FOR_CONFIG="${CUSTOM_PROVIDER:-custom}"
  [ -n "$LLM_API_KEY" ] && export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
fi
export MODEL_FOR_CONFIG PROVIDER_FOR_CONFIG CUSTOM_BASE_URL="${CUSTOM_BASE_URL:-}" CUSTOM_API_KEY="${CUSTOM_API_KEY:-${LLM_API_KEY:-}}"
export CUSTOM_MODEL_CONTEXT_LENGTH="${CUSTOM_MODEL_CONTEXT_LENGTH:-131072}" CUSTOM_MODEL_MAX_TOKENS="${CUSTOM_MODEL_MAX_TOKENS:-8192}"
export TELEGRAM_BASE_URL="${TELEGRAM_BASE_URL:-}" TELEGRAM_BASE_FILE_URL="${TELEGRAM_BASE_FILE_URL:-}"
if [ -n "${CLOUDFLARE_PROXY_URL:-}" ] && [ -z "$TELEGRAM_BASE_URL" ]; then
  CLOUDFLARE_PROXY_URL="${CLOUDFLARE_PROXY_URL%/}"
  export TELEGRAM_BASE_URL="${CLOUDFLARE_PROXY_URL}/bot" TELEGRAM_BASE_FILE_URL="${CLOUDFLARE_PROXY_URL}/file/bot"
fi

python3 - <<'PY'
import os
from pathlib import Path
import yaml
home = Path(os.environ["HERMES_HOME"])
path = home / "config.yaml"
try:
    config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
except FileNotFoundError:
    config = {}
model_name = os.environ.get("MODEL_FOR_CONFIG", "").strip()
provider_name = os.environ.get("PROVIDER_FOR_CONFIG", "").strip()
if model_name:
    model = config.setdefault("model", {})
    model["default"] = model_name
    if provider_name and provider_name != "auto":
        model["provider"] = provider_name
    else:
        model.pop("provider", None)
custom_base = os.environ.get("CUSTOM_BASE_URL", "").strip()
if custom_base and model_name:
    model = config.setdefault("model", {})
    model.setdefault("base_url", custom_base.rstrip("/"))
    if os.environ.get("CUSTOM_API_KEY"):
        model.setdefault("api_key", os.environ["CUSTOM_API_KEY"])
config.setdefault("terminal", {}).setdefault("cwd", os.environ.get("MESSAGING_CWD", str(home / "workspace")))
config.setdefault("compression", {}).setdefault("enabled", True)
config.setdefault("security", {}).setdefault("redact_secrets", True)
platforms = config.setdefault("platforms", {})
if os.environ.get("TELEGRAM_BOT_TOKEN"):
    telegram = platforms.setdefault("telegram", {})
    telegram.setdefault("enabled", True)
    extra = telegram.setdefault("extra", {})
    if os.environ.get("TELEGRAM_BASE_URL"):
        extra.setdefault("base_url", os.environ["TELEGRAM_BASE_URL"])
        extra.setdefault("base_file_url", os.environ.get("TELEGRAM_BASE_FILE_URL") or os.environ["TELEGRAM_BASE_URL"])
    if os.environ.get("TELEGRAM_ALLOWED_USERS"):
        config.setdefault("telegram", {}).setdefault("allow_from", [item.strip() for item in os.environ["TELEGRAM_ALLOWED_USERS"].split(",") if item.strip()])
path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
path.chmod(0o600)
PY

echo "Model    : ${MODEL_FOR_CONFIG:-unset}"
echo "Provider : ${PROVIDER_FOR_CONFIG:-unset}"
if [ -n "${WHATSAPP_ACCESS_TOKEN:-}" ] && [ -n "${WHATSAPP_PHONE_NUMBER_ID:-}" ] && [ -n "${WHATSAPP_VERIFY_TOKEN:-}" ]; then
  echo "WhatsApp : enabled (${WHATSAPP_PROVIDER}) at /whatsapp/webhook"
else
  echo "WhatsApp : not configured"
fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then echo "Telegram : enabled"; else echo "Telegram : not configured"; fi
if [ -n "${HF_TOKEN:-}" ]; then echo "Backup   : ${BACKUP_DATASET} (every ${SYNC_INTERVAL}s)"; else echo "Backup   : disabled"; fi
echo "Dashboard: http://127.0.0.1:${DASHBOARD_PORT}"
echo "Gateway  : http://127.0.0.1:${GATEWAY_API_PORT}"

graceful_shutdown() {
  echo "Shutting down HuggingMes..."
  if [ -n "${HF_TOKEN:-}" ]; then python3 "$APP_DIR/hermes-sync.py" sync-once || echo "Warning: shutdown sync failed."; fi
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap graceful_shutdown SIGTERM SIGINT

node "$APP_DIR/health-server.js" &
HEALTH_PID=$!

if [ -n "${WEBHOOK_URL:-}" ]; then
  python3 - <<'PY' >/dev/null 2>&1 &
import json, os, urllib.request
body = json.dumps({"event":"restart","status":"success","message":"HuggingMes Hermes gateway has started.","model":os.environ.get("MODEL_FOR_CONFIG","")}).encode()
req = urllib.request.Request(os.environ["WEBHOOK_URL"], data=body, method="POST", headers={"Content-Type":"application/json"})
urllib.request.urlopen(req, timeout=10).read()
PY
fi

echo "Launching Hermes dashboard on 127.0.0.1:${DASHBOARD_PORT}..."
(hermes dashboard --host 127.0.0.1 --insecure 2>&1 | tee -a "$HERMES_HOME/logs/dashboard.log") &
DASHBOARD_PID=$!

echo "Launching Hermes gateway..."
(hermes gateway run 2>&1 | tee -a "$HERMES_HOME/logs/gateway.log") &
GATEWAY_PID=$!

GATEWAY_READY_TIMEOUT="${GATEWAY_READY_TIMEOUT:-120}"
ready=false
for ((i=0; i<GATEWAY_READY_TIMEOUT; i++)); do
  if (echo > "/dev/tcp/127.0.0.1/${GATEWAY_API_PORT}") 2>/dev/null; then ready=true; break; fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$ready" != "true" ]; then
  echo "Hermes gateway failed to expose the API health port. Last 40 log lines:" >&2
  tail -40 "$HERMES_HOME/logs/gateway.log" || true
  exit 1
fi

if [ -n "${HF_TOKEN:-}" ]; then python3 -u "$APP_DIR/hermes-sync.py" loop & fi
wait "$GATEWAY_PID"
if [ -n "${HF_TOKEN:-}" ]; then python3 "$APP_DIR/hermes-sync.py" sync-once || echo "Warning: final sync failed."; fi
