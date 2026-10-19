#!/usr/bin/env bash
# LifeOS – Einrichtung eines frischen Ubuntu-24.04-VPS (idempotent).
#
# Läuft aus einem Git-Klon des Repos, nichts wird per curl nachgeladen:
#   gh auth login -s read:packages            # einmalig, als normaler Nutzer
#   sudo git clone https://github.com/ZitrusmitZ/lifeos /opt/lifeos
#   sudo bash /opt/lifeos/deploy/bootstrap-vps.sh
#   sudo --preserve-env=SSH_CLIENT bash /opt/lifeos/deploy/bootstrap-vps.sh --lockdown-ssh   # danach: öffentliches SSH schließen
#
# Ergebnis: LifeOS läuft in Docker auf 127.0.0.1:3000 und ist NUR im Tailnet erreichbar:
#   https://<hostname>.<tailnet>.ts.net  (TLS-Zertifikat verwaltet Tailscale)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTNAME_TS="${LIFEOS_HOSTNAME:-lifeos}"
DEPLOY_USER="${SUDO_USER:-ubuntu}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Bitte als root starten (sudo bash $0)"
[[ -f "$APP_DIR/compose.yaml" ]] || die "$APP_DIR ist kein LifeOS-Klon"

ts_dns() { tailscale status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'; }

lockdown_ssh() {
  log "Öffentliches SSH schließen"
  tailscale status >/dev/null 2>&1 || die "Tailscale ist nicht verbunden"
  # sudo verwirft SSH_CLIENT – daher mit `sudo --preserve-env=SSH_CLIENT` starten (siehe Kopf) oder aus `who` ableiten
  local client="${SSH_CLIENT:-}"
  [[ -n "$client" ]] || client="$(who -m 2>/dev/null | grep -oE '\(([0-9a-f.:]+)\)' | tr -d '()' || true)"
  local client_ip="${client%% *}"
  if [[ -n "$client_ip" && ! "$client_ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
    die "Du bist über $client_ip verbunden, nicht über Tailscale. Erst per 'ssh $DEPLOY_USER@$(tailscale ip -4)' neu verbinden."
  fi
  ufw delete allow 22/tcp >/dev/null 2>&1 || true
  touch /etc/lifeos-ssh-locked
  ufw status verbose
  echo "SSH ist jetzt nur noch über das Tailnet erreichbar: ssh $DEPLOY_USER@$(tailscale ip -4)"
}

if [[ "${1:-}" == "--lockdown-ssh" ]]; then lockdown_ssh; exit 0; fi

log "Pakete (Docker, Tailscale, GitHub CLI aus den offiziellen Paketquellen)"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
if ! command -v docker >/dev/null || ! command -v tailscale >/dev/null || ! command -v gh >/dev/null; then
  apt-get update -q
  apt-get install -yq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$VERSION_CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$VERSION_CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod a+r /etc/apt/keyrings/*
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin tailscale gh
fi
apt-get install -yq ufw unattended-upgrades fail2ban sqlite3 >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now docker tailscaled
usermod -aG docker "$DEPLOY_USER"
timedatectl set-timezone Europe/Berlin || true

log "Tailscale"
if [[ "$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["BackendState"])' 2>/dev/null)" != "Running" ]]; then
  echo "Öffne gleich den angezeigten Login-Link im Browser, um den VPS deinem Tailnet hinzuzufügen."
  tailscale up --hostname="$HOSTNAME_TS"
fi

log "Firewall (UFW): eingehend nur Tailscale"
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp comment 'Tailscale direkte Verbindungen'
# Nach --lockdown-ssh nicht wieder öffnen, wenn das Skript erneut läuft
[[ -f /etc/lifeos-ssh-locked ]] || ufw allow 22/tcp comment 'SSH (Notzugang, später: --lockdown-ssh)'
ufw --force enable

log "GHCR-Login (Image ziehen, auch wenn das Paket privat ist)"
if sudo -u "$DEPLOY_USER" gh auth status >/dev/null 2>&1; then
  sudo -u "$DEPLOY_USER" gh auth token | docker login ghcr.io -u "$(sudo -u "$DEPLOY_USER" gh api user --jq .login)" --password-stdin
else
  echo "gh ist nicht eingeloggt – Image wird nur gezogen, wenn das GHCR-Paket öffentlich ist."
fi

log "LifeOS in $APP_DIR"
cd "$APP_DIR"
mkdir -p data/backups
chown -R 1000:1000 data   # Container läuft als Nutzer 'node' (uid 1000)
if [[ ! -f .env ]]; then
  cp .env.example .env
  sed -i "s|^APP_URL=.*|APP_URL=https://$(ts_dns)|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
  sed -i "s|^INGEST_TOKEN=.*|INGEST_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')|" .env
  echo "Neue .env angelegt (Schlüssel generiert). API-Zugangsdaten bitte selbst eintragen: sudo nano $APP_DIR/.env"
fi
# Nachträglich hinzugekommene Schlüssel ergänzen (ältere .env-Dateien)
grep -q '^CRON_TOKEN=.\+' .env || { sed -i '/^CRON_TOKEN=/d' .env; echo "CRON_TOKEN=$(openssl rand -hex 24)" >> .env; }
chmod 600 .env

log "Container starten"
docker compose pull
docker compose up -d --no-build

log "Im Tailnet veröffentlichen (tailscale serve, kein Funnel)"
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status

log "Timer: Auto-Update (10 min), Backup (03:30), Mail-Assistent (06:00 + 16:00)"
for unit in deploy/systemd/*.service deploy/systemd/*.timer; do
  sed "s|/opt/lifeos|$APP_DIR|g" "$unit" > "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable --now lifeos-update.timer lifeos-backup.timer lifeos-mail.timer

log "Fertig"
echo "Dashboard:  https://$(ts_dns)"
echo "Nächste Schritte: .env ausfüllen → 'cd $APP_DIR && docker compose up -d --no-build' → OAuth in Einstellungen → '$0 --lockdown-ssh'"
