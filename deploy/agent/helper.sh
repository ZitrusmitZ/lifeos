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
DEPLOY_DIR="/opt/lifeos"
DEPLOY_BRANCH="main"
DEPLOY_IMAGE="ghcr.io/zitrusmitz/lifeos"
DEPLOY_CONTAINER="lifeos"
# shellcheck source=/dev/null
[[ -f "$CONF" && "$(stat -c %u "$CONF")" == 0 ]] && . "$CONF"

die() { echo "helper: $*" >&2; exit 64; }
in_list() { local x="$1"; shift; for v in $*; do [[ "$v" == "$x" ]] && return 0; done; return 1; }
# Wert zu Schlüssel aus "a=b c=d"
lookup() { local key="$1"; shift; for kv in $*; do [[ "${kv%%=*}" == "$key" ]] && { echo "${kv#*=}"; return 0; }; done; return 1; }
name_ok() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$ ]] || die "ungültiger Name"; }

# ── Deploy (LifeOS-Repo + per Digest gepinntes GHCR-Image + Agent) ──
dgit() { git -c safe.directory="$DEPLOY_DIR" -C "$DEPLOY_DIR" "$@"; }
deploy_check() {
  [[ -d "$DEPLOY_DIR/.git" && -f "$DEPLOY_DIR/compose.override.yaml" ]] || die "DEPLOY_DIR ($DEPLOY_DIR) ist kein LifeOS-Checkout mit compose.override.yaml"
  [[ "$DEPLOY_BRANCH" =~ ^[a-zA-Z0-9._/-]{1,64}$ && "$DEPLOY_IMAGE" =~ ^[a-z0-9./_-]{1,128}$ ]] || die "DEPLOY_BRANCH/DEPLOY_IMAGE ungültig"
}
running_rev() { docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$DEPLOY_CONTAINER" 2>/dev/null | cut -c1-7; }
wait_healthy() {
  local s
  for _ in $(seq 1 40); do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$DEPLOY_CONTAINER" 2>/dev/null || true)"
    [[ "$s" == healthy || "$s" == running ]] && return 0
    sleep 3
  done
  return 1
}

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
  deploy-preview)
    deploy_check
    dgit fetch --quiet origin "$DEPLOY_BRANCH" 2>&1 || die "git fetch fehlgeschlagen"
    cur="$(dgit rev-parse --short=7 HEAD)"; new="$(dgit rev-parse --short=7 "origin/$DEPLOY_BRANCH")"
    rev="$(running_rev || true)"
    echo "Repo: $cur → $new · Container läuft mit ${rev:-?}"
    if [[ "$cur" == "$new" && "$rev" == "$new" ]]; then
      echo "Schon aktuell – ein Deploy startet nur Container und Agent neu."
    else
      dgit log --oneline --no-decorate -n 20 "HEAD..origin/$DEPLOY_BRANCH"
    fi
    if timeout 30 docker manifest inspect "$DEPLOY_IMAGE:sha-$new" >/dev/null 2>&1; then
      echo "Image sha-$new: bereit"
    else
      echo "Image sha-$new: noch nicht da (Release-Build läuft?) – der Deploy wartet bis zu 10 Min darauf"
    fi
    ;;
  deploy-run)
    deploy_check
    exec 9>/run/lock/lifeos-deploy.lock
    flock -n 9 || die "Es läuft schon ein Deploy"
    stamp="$(date +%Y%m%d-%H%M%S)"
    override="$DEPLOY_DIR/compose.override.yaml"
    old="$(dgit rev-parse --short=7 HEAD)"
    dgit pull --ff-only --quiet origin "$DEPLOY_BRANCH" 2>&1 || die "git pull --ff-only fehlgeschlagen (lokale Änderungen in $DEPLOY_DIR?)"
    commit="$(dgit rev-parse --short=7 HEAD)"
    echo "Repo: $old → $commit"
    tag="$DEPLOY_IMAGE:sha-$commit"
    for i in $(seq 1 60); do
      docker pull -q "$tag" >/dev/null 2>&1 && break
      [[ $i -eq 60 ]] && die "Image $tag nach 10 Min nicht verfügbar – Release-Workflow prüfen"
      sleep 10
    done
    digest="$(docker image inspect "$tag" -f '{{range .RepoDigests}}{{println .}}{{end}}' | grep -m1 "^$DEPLOY_IMAGE@" || true)"
    [[ -n "$digest" ]] || die "Digest für $tag nicht gefunden"
    rev="$(docker image inspect "$tag" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    [[ "$rev" == "$commit"* ]] || die "Image-Revision $rev passt nicht zu $commit"
    cp -a "$override" "$override.bak-$stamp"
    rollback() {
      cp -a "$override.bak-$stamp" "$override"
      (cd "$DEPLOY_DIR" && docker compose up -d --no-build >/dev/null 2>&1) || true
    }
    sed -i -E "s#^(\s*image:\s*).*#\1$digest#" "$override"
    echo "Pin: ${digest#*@}" | cut -c1-80
    if ! (cd "$DEPLOY_DIR" && docker compose config --quiet && docker compose up -d --no-build --force-recreate 2>&1 | tail -5); then
      rollback; die "docker compose up fehlgeschlagen – alter Pin wiederhergestellt"
    fi
    wait_healthy || { rollback; die "$DEPLOY_CONTAINER wird nicht healthy – alter Pin wiederhergestellt"; }
    echo "$DEPLOY_CONTAINER: $(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$DEPLOY_CONTAINER")"
    ls -1t "$override".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f   # die letzten 5 Backups behalten
    docker image prune -f >/dev/null 2>&1 || true
    # Agent-Update außerhalb des Agent-Prozesses (install_agent.sh startet ihn neu) – eigene transiente Unit,
    # 10 s Verzögerung, damit die Antwort noch im Chat ankommt
    systemd-run --quiet --collect --unit="lifeos-agent-update-$stamp" --on-active=10 /usr/bin/bash "$DEPLOY_DIR/scripts/install_agent.sh"
    echo "Agent-Update startet in 10 s (journalctl -u lifeos-agent-update-$stamp)"
    ;;
  *)
    die "unbekanntes Verb: ${verb:-<leer>}"
    ;;
esac
