#!/usr/bin/env bash
# FreeLLM (LiteLLM-Proxy) installieren bzw. aktualisieren – idempotent.
#   sudo bash scripts/install_litellm.sh
# Macht: /etc/litellm/litellm.env (Vorlage + Master-Key), /opt/litellm/{compose.yaml,config.yaml} aus deploy/litellm,
# Container `litellm` auf 127.0.0.1:4000 starten, URL + Key in /etc/lifeos-agent/agent.env eintragen,
# `litellm` in die Whitelist des Agenten (Status/Logs/Neustart) aufnehmen, Agent neu starten.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo ausführen." >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/litellm
ETC=/etc/litellm
ENV="$ETC/litellm.env"
AGENT_ENV=/etc/lifeos-agent/agent.env
HELPER_CONF=/etc/lifeos-agent/helper.conf

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
val() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# Schlüssel in einer env-Datei setzen (ohne den Wert je auszugeben)
setval() { sed -i "/^$1=/d" "$3"; echo "$1=$2" >>"$3"; }

# ── Keys ──────────────────────────────────────────────────────────────
install -d -m 700 "$ETC"
if [[ ! -f "$ENV" ]]; then
  install -m 600 "$REPO/deploy/litellm/litellm.env.example" "$ENV"
  say "$ENV angelegt"
fi
chown root:root "$ENV"; chmod 600 "$ENV"
if [[ -z "$(val LITELLM_MASTER_KEY "$ENV")" ]]; then
  setval LITELLM_MASTER_KEY "sk-$(openssl rand -hex 24)" "$ENV"
  say "Master-Key erzeugt"
fi

# ── config.yaml aus models.txt (nur Anbieter mit Key) ────────────────
install -d -m 755 "$APP"
models=0
{
  echo "# erzeugt von scripts/install_litellm.sh aus deploy/litellm/models.txt – nicht von Hand ändern"
  echo "model_list:"
  while read -r keyvar model rpm; do
    [[ -z "$keyvar" || "$keyvar" == \#* ]] && continue
    [[ -n "$(val "$keyvar" "$ENV")" ]] || continue
    printf '  - model_name: free\n    litellm_params:\n      model: "%s"\n      api_key: os.environ/%s\n      rpm: %s\n' "$model" "$keyvar" "${rpm:-10}"
    models=$((models + 1))
  done <"$REPO/deploy/litellm/models.txt"
  cat <<'YAML'
router_settings:
  routing_strategy: simple-shuffle
  num_retries: 2
  allowed_fails: 1
  cooldown_time: 300
litellm_settings:
  drop_params: true
  request_timeout: 90
  telemetry: false
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
YAML
} >"$APP/config.yaml.new"
if ((models == 0)); then
  rm -f "$APP/config.yaml.new"
  say "Noch kein API-Key in $ENV – mindestens einen eintragen, dann dieses Skript erneut ausführen:"
  echo "  sudo nano $ENV"
  exit 0
fi
mv "$APP/config.yaml.new" "$APP/config.yaml"
chmod 644 "$APP/config.yaml"
install -m 644 "$REPO/deploy/litellm/compose.yaml" "$APP/compose.yaml"
say "$models Anbieter in der Modellgruppe „free“"

# ── Container ─────────────────────────────────────────────────────────
say "LiteLLM starten"
(cd "$APP" && docker compose pull --quiet && docker compose up -d --force-recreate)
ok=false
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1 && { ok=true; break; }
  sleep 2
done
$ok || { echo "LiteLLM antwortet nicht – docker logs litellm" >&2; exit 1; }

# Probeanfrage (Antwort wird nicht ausgegeben, nur das Modell)
key="$(val LITELLM_MASTER_KEY "$ENV")"
probe="$(curl -fsS -m 60 http://127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  -d '{"model":"free","max_tokens":5,"messages":[{"role":"user","content":"Sag nur: ok"}]}' 2>&1 | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("model","?"))
except Exception: print("")' || true)"
if [[ -n "$probe" ]]; then say "Probeanfrage ok ($probe)"; else echo "⚠️ Probeanfrage fehlgeschlagen – Keys/Modellnamen prüfen: docker logs litellm" >&2; fi

# ── Agent anbinden ────────────────────────────────────────────────────
if [[ -f "$AGENT_ENV" ]]; then
  setval ENABLE_FREE_PROVIDER true "$AGENT_ENV"
  setval FREE_LLM_URL http://127.0.0.1:4000 "$AGENT_ENV"
  setval FREE_LLM_KEY "$key" "$AGENT_ENV"
  services="$(val AGENT_SERVICES "$AGENT_ENV")"
  if [[ -n "$services" && ",$services," != *",litellm:docker,"* ]]; then setval AGENT_SERVICES "$services,litellm:docker" "$AGENT_ENV"; fi
  chmod 600 "$AGENT_ENV"
  if [[ -f "$HELPER_CONF" ]] && ! grep -qE '^ALLOWED_DOCKER=.*\blitellm\b' "$HELPER_CONF"; then
    sed -i -E 's/^ALLOWED_DOCKER="([^"]*)"/ALLOWED_DOCKER="\1 litellm"/' "$HELPER_CONF"
  fi
  systemctl restart lifeos-agent
  say "Agent nutzt FreeLLM, wenn das Pro-Kontingent leer ist (/quota zeigt den Status)"
else
  say "$AGENT_ENV fehlt – erst scripts/install_agent.sh ausführen"
fi
