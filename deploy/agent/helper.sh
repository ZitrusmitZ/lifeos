#!/usr/bin/env bash
# LifeOS-Agent: Root-Helfer für Server-Aktionen. Installiert nach /usr/local/lib/lifeos-agent/helper (root:root 755).
# Der Agent-Nutzer `lifeos` darf per sudoers NUR dieses Skript aufrufen. Jedes Verb und jeder Name wird hier
# nochmal gegen /etc/lifeos-agent/helper.conf (root-owned) geprüft – der Agent kann die Whitelist nicht erweitern.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONF=/etc/lifeos-agent/helper.conf
ALLOWED_SYSTEMD=""
ALLOWED_DOCKER=""
MC_CONTAINER="minecraft"
BACKUP_UNITS=""
PROJECTS=""
# shellcheck source=/dev/null
[[ -f "$CONF" && "$(stat -c %u "$CONF")" == 0 ]] && . "$CONF"

die() { echo "helper: $*" >&2; exit 64; }
in_list() { local x="$1"; shift; for v in $*; do [[ "$v" == "$x" ]] && return 0; done; return 1; }
# Wert zu Schlüssel aus "a=b c=d"
lookup() { local key="$1"; shift; for kv in $*; do [[ "${kv%%=*}" == "$key" ]] && { echo "${kv#*=}"; return 0; }; done; return 1; }
name_ok() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$ ]] || die "ungültiger Name"; }

verb="${1:-}"; shift || true
case "$verb" in
  docker-status)
    name_ok "${1:-}"; in_list "$1" "$ALLOWED_DOCKER" || die "Container nicht erlaubt: $1"
    docker inspect -f 'running={{.State.Running}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} started={{.State.StartedAt}} restarts={{.RestartCount}}' "$1"
    ;;
  docker-logs)
    name_ok "${1:-}"; in_list "$1" "$ALLOWED_DOCKER" || die "Container nicht erlaubt: $1"
    n="${2:-30}"; [[ "$n" =~ ^[0-9]{1,3}$ && "$n" -ge 1 && "$n" -le 100 ]] || die "n muss 1–100 sein"
    docker logs --tail "$n" "$1" 2>&1
    ;;
  docker-restart)
    name_ok "${1:-}"; in_list "$1" "$ALLOWED_DOCKER" || die "Container nicht erlaubt: $1"
    docker restart -t 90 "$1" >/dev/null && echo "$1 neu gestartet"
    ;;
  systemd-restart)
    name_ok "${1:-}"; in_list "$1" "$ALLOWED_SYSTEMD" || die "Dienst nicht erlaubt: $1"
    systemctl restart "$1.service" && systemctl is-active "$1.service"
    ;;
  mc-status)
    if [[ "$(docker inspect -f '{{.State.Running}}' "$MC_CONTAINER" 2>/dev/null)" == "true" ]]; then
      echo "running=true"
      timeout 10 docker exec "$MC_CONTAINER" rcon-cli list 2>&1 || echo "rcon nicht erreichbar"
    else
      echo "running=false"
    fi
    ;;
  mc-say)
    # Text kommt über stdin: eine Zeile, ohne Steuerzeichen und Formatcodes, max. 200 Zeichen
    IFS= read -r -n 400 msg || true
    msg="$(printf '%s' "$msg" | tr -d '\000-\037\177' | sed 's/§//g' | cut -c1-200)"
    [[ -n "${msg// /}" ]] || die "leere Nachricht"
    docker exec "$MC_CONTAINER" rcon-cli say "[Server] $msg"
    ;;
  mc-restart)
    docker exec "$MC_CONTAINER" rcon-cli say "Server startet in 10 Sekunden neu." >/dev/null 2>&1 || true
    sleep 10
    docker restart -t 90 "$MC_CONTAINER" >/dev/null && echo "Minecraft neu gestartet"
    ;;
  backup)
    name_ok "${1:-}"; unit="$(lookup "$1" "$BACKUP_UNITS")" || die "Backup-Ziel nicht erlaubt: $1"
    systemctl start --wait "$unit" && echo "$unit fertig" && journalctl -u "$unit" -n 5 --no-pager -o cat
    ;;
  git-pull)
    name_ok "${1:-}"; dir="$(lookup "$1" "$PROJECTS")" || die "Projekt nicht erlaubt: $1"
    git -c safe.directory="$dir" -C "$dir" pull --ff-only 2>&1
    ;;
  *)
    die "unbekanntes Verb: ${verb:-<leer>}"
    ;;
esac
