#!/usr/bin/env bash
# LifeOS Telegram-Agent installieren bzw. aktualisieren (idempotent – beliebig oft ausführbar).
#   sudo bash scripts/install_agent.sh
# Macht: Node ≥ 22.18, Nutzer `lifeos`, App nach /opt/lifeos-agent, Root-Helfer + sudoers, Ollama (+ Modell, MemoryMax=5G),
# claude-CLI für `lifeos`, systemd-Unit. Loggt NICHT bei Claude ein – dafür wird am Ende eine Anleitung ausgegeben.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo ausführen." >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/lifeos-agent
DATA=/var/lib/lifeos-agent
ETC=/etc/lifeos-agent
HELPER_DIR=/usr/local/lib/lifeos-agent
NODE_MAJOR=24

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
envval() { grep -E "^$1=" "$ETC/agent.env" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# ── Node ──────────────────────────────────────────────────────────────
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; }
if ! node_ok; then
  say "Node $NODE_MAJOR installieren (offizieller Tarball, Prüfsumme)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz" | head -1)"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -)
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
fi
say "Node $(node -v)"

# ── Nutzer ────────────────────────────────────────────────────────────
if ! id lifeos >/dev/null 2>&1; then
  say "Nutzer lifeos anlegen"
  useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin lifeos
fi
usermod -aG systemd-journal lifeos   # journalctl -u … ohne sudo
install -d -o lifeos -g lifeos -m 750 "$DATA" "$DATA/workspace" "$DATA/logs"

# ── App ───────────────────────────────────────────────────────────────
say "App nach $APP kopieren"
install -d -m 755 "$APP/src/agent" "$APP/src/lib"
rsync -a --delete "$REPO/src/agent/" "$APP/src/agent/"
install -m 644 "$REPO/src/lib/time.ts" "$APP/src/lib/time.ts"
zod_version="$(node -p "require('$REPO/package-lock.json').packages['node_modules/zod'].version")"
cat >"$APP/package.json" <<EOF
{ "name": "lifeos-agent", "private": true, "type": "module", "dependencies": { "zod": "$zod_version" } }
EOF
if [[ "$(node -p "try{require('$APP/node_modules/zod/package.json').version}catch{''}")" != "$zod_version" ]]; then
  (cd "$APP" && npm install --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error)
fi
chown -R root:root "$APP"

# ── Konfiguration ─────────────────────────────────────────────────────
install -d -m 755 "$ETC"
if [[ ! -f "$ETC/agent.env" ]]; then
  say "$ETC/agent.env aus Vorlage anlegen"
  install -m 600 "$REPO/deploy/agent/agent.env.example" "$ETC/agent.env"
fi
chmod 600 "$ETC/agent.env"; chown root:root "$ETC/agent.env"
# CRON_TOKEN von LifeOS übernehmen (Kalender fürs Briefing), falls noch leer
if [[ -z "$(envval LIFEOS_CRON_TOKEN)" && -f /opt/lifeos/.env ]]; then
  token="$(grep -E '^CRON_TOKEN=' /opt/lifeos/.env | tail -1 | cut -d= -f2-)"
  if [[ -n "$token" ]]; then
    sed -i '/^LIFEOS_CRON_TOKEN=/d' "$ETC/agent.env"
    echo "LIFEOS_CRON_TOKEN=$token" >>"$ETC/agent.env"
    say "LIFEOS_CRON_TOKEN aus /opt/lifeos/.env übernommen"
  fi
fi
[[ -f "$ETC/helper.conf" ]] || install -m 644 "$REPO/deploy/agent/helper.conf" "$ETC/helper.conf"
# neue Schlüssel aus der Vorlage ergänzen (bestehende Werte bleiben unangetastet)
for key in DEPLOY_DIR DEPLOY_BRANCH DEPLOY_IMAGE DEPLOY_CONTAINER ROOT_EXEC ROOT_EXEC_LOG CODE_REPOS CODE_USER CODE_MAX; do
  grep -q "^$key=" "$ETC/helper.conf" || grep -m1 "^$key=" "$REPO/deploy/agent/helper.conf" >>"$ETC/helper.conf"
done
chown root:root "$ETC/helper.conf"; chmod 644 "$ETC/helper.conf"

# ── Root-Befehle + Coding-Agents ──────────────────────────────────────
# Protokoll der Root-Befehle gehört root (der Agent kann es lesen, aber nicht ändern).
install -d -m 750 -o root -g lifeos /var/log/lifeos-agent
code_user="$(grep -E '^CODE_USER=' "$ETC/helper.conf" | tail -1 | cut -d= -f2- | tr -d '"')"; code_user="${code_user:-luis}"
if id "$code_user" >/dev/null 2>&1; then
  # Status/Verlauf der Coding-Agents: schreibt $code_user, Gruppe lifeos (Agent) liest
  install -d -m 2750 -o "$code_user" -g lifeos /var/lib/lifeos-coder
  # FreeLLM-Fallback für Coding-Agents: Key aus agent.env (nur root lesbar, systemd gibt ihn an die Unit)
  {
    echo "# erzeugt von scripts/install_agent.sh aus agent.env – nicht von Hand ändern"
    echo "FREELLM_URL=$(envval FREE_LLM_URL)"
    echo "FREELLM_KEY=$(envval FREE_LLM_KEY)"
    for k in CODER_MODEL CODER_FREE_MODEL CODER_FREE_FALLBACK CODER_FORCE_FREE; do
      v="$(envval "$k")"; if [[ -n "$v" ]]; then echo "$k=$v"; fi
    done
  } >"$ETC/coder.env"
  chown root:root "$ETC/coder.env"; chmod 600 "$ETC/coder.env"
  say "Coding-Agents laufen als $code_user (Repos: $(grep -E '^CODE_REPOS=' "$ETC/helper.conf" | cut -d= -f2-))"
else
  echo "  CODE_USER=$code_user existiert nicht – Coding-Agents aus" >&2
fi

# ── Ordner für run_task (AGENT_FILE_DIRS) ─────────────────────────────
# Nur hier freigegebene Ordner sind für den Dienst beschreibbar (systemd ReadWritePaths) und für lifeos per ACL.
command -v setfacl >/dev/null || { say "acl installieren"; apt-get install -y -qq acl >/dev/null; }
file_dirs="$(envval AGENT_FILE_DIRS)"; file_dirs="${file_dirs:-/srv/homeserver}"
rw_paths=()
IFS=',' read -ra dirs <<<"$file_dirs"
for d in "${dirs[@]}"; do
  d="$(echo "$d" | xargs)"; d="${d%/}"
  [[ -n "$d" ]] || continue
  if [[ "$d" != /* || "$d" == *..* || "$d" =~ ^/(home|root|etc|usr|boot|proc|sys|dev|run|bin|sbin|lib|lib64|var/lib/lifeos-agent)(/|$) || "$d" == / ]]; then
    echo "  AGENT_FILE_DIRS: $d übersprungen (nicht erlaubt)" >&2; continue
  fi
  install -d -m 755 "$d"
  setfacl -R -m u:lifeos:rwX -m d:u:lifeos:rwX "$d"
  rw_paths+=("$d")
done
install -d -m 755 /etc/systemd/system/lifeos-agent.service.d
{
  echo "# erzeugt von scripts/install_agent.sh aus AGENT_FILE_DIRS – nicht von Hand ändern"
  echo "[Service]"
  if ((${#rw_paths[@]})); then echo "ReadWritePaths=${rw_paths[*]}"; fi
} >/etc/systemd/system/lifeos-agent.service.d/files.conf
if ((${#rw_paths[@]})); then say "run_task darf in: ${rw_paths[*]}"; fi

# ── Root-Helfer + sudoers ─────────────────────────────────────────────
say "Root-Helfer und sudoers"
install -d -m 755 "$HELPER_DIR"
install -m 755 -o root -g root "$REPO/deploy/agent/helper.sh" "$HELPER_DIR/helper"
tmp_sudo="$(mktemp)"
install -m 440 "$REPO/deploy/agent/sudoers" "$tmp_sudo"
visudo -cf "$tmp_sudo" >/dev/null
install -m 440 -o root -g root "$tmp_sudo" /etc/sudoers.d/lifeos-agent
rm -f "$tmp_sudo"

# ── Ollama ────────────────────────────────────────────────────────────
if ! command -v ollama >/dev/null; then
  say "Ollama installieren"
  curl -fsSL https://ollama.com/install.sh | sh
fi
install -d -m 755 /etc/systemd/system/ollama.service.d
install -m 644 "$REPO/deploy/agent/ollama.conf" /etc/systemd/system/ollama.service.d/lifeos.conf
systemctl daemon-reload
systemctl enable ollama >/dev/null 2>&1
systemctl restart ollama
model="$(envval OLLAMA_MODEL)"; model="${model:-qwen2.5:3b}"
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
  say "Modell $model laden (einmalig ~2 GB)"
  ollama pull "$model"
fi

# ── claude-CLI für lifeos ─────────────────────────────────────────────
CLAUDE="$DATA/.local/bin/claude"
if [[ ! -x "$CLAUDE" ]]; then
  say "claude-CLI für lifeos installieren"
  sudo -u lifeos -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
fi
claude_ok=false
oauth="$(envval CLAUDE_CODE_OAUTH_TOKEN)"
# Das Token geht nur an die CLI selbst (`auth status`), sonst nirgendwohin.
if CLAUDE_CODE_OAUTH_TOKEN="$oauth" sudo --preserve-env=CLAUDE_CODE_OAUTH_TOKEN -u lifeos -H "$CLAUDE" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
  claude_ok=true
fi

# ── systemd ───────────────────────────────────────────────────────────
install -m 644 "$REPO/deploy/agent/lifeos-agent.service" /etc/systemd/system/lifeos-agent.service
systemctl daemon-reload
systemctl enable lifeos-agent >/dev/null 2>&1

# Mindestens ein Kanal: Telegram (Token + User-ID) oder der Web-Chat (LIFEOS_CRON_TOKEN)
missing=()
if [[ -z "$(envval TELEGRAM_BOT_TOKEN)" && -z "$(envval LIFEOS_CRON_TOKEN)" ]]; then
  missing+=("TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID oder LIFEOS_CRON_TOKEN")
elif [[ -n "$(envval TELEGRAM_BOT_TOKEN)" && -z "$(envval TELEGRAM_ALLOWED_USER_ID)" ]]; then
  missing+=(TELEGRAM_ALLOWED_USER_ID)
fi

echo
if ((${#missing[@]})); then
  say "Fast fertig – in $ETC/agent.env fehlt noch: ${missing[*]}"
  echo "  sudo nano $ETC/agent.env && sudo systemctl restart lifeos-agent"
else
  systemctl restart lifeos-agent
  say "lifeos-agent läuft: systemctl status lifeos-agent · journalctl -u lifeos-agent -f"
fi
if ! $claude_ok; then
  echo
  say "Claude ist für lifeos noch nicht eingeloggt (der Bot läuft bis dahin nur lokal):"
  echo "  sudo -u lifeos -H $CLAUDE setup-token"
  echo "  → Token als CLAUDE_CODE_OAUTH_TOKEN=… in $ETC/agent.env eintragen, dann: sudo systemctl restart lifeos-agent"
fi
