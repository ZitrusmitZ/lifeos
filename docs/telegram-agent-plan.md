# Telegram-Agent – Plan

Stand: 2026-10-22 · Branch `feat/telegram-agent`

## Befund (Phase 1)

| Thema | Ist-Zustand im Repo |
|---|---|
| Stack | Next.js 16 · TypeScript (strict) · Zod · `node:sqlite` · Vitest · ESLint (next config) · npm |
| Laufzeit | LifeOS läuft als Docker-Container (`compose.yaml`, nur `127.0.0.1:3000`, Zugriff über `tailscale serve`) |
| Config | `.env` → `src/lib/env.ts` (Zod-Schema); Laufzeit-Einstellungen in der Tabelle `settings` |
| Daten | SQLite unter `DATA_DIR` (Container: `/data` = `/opt/lifeos/data`), Migrationen über `PRAGMA user_version` |
| Scheduler | Minuten-Loop im Next-Prozess (`src/lib/reminders.ts`), dazu systemd-Timer → `POST /api/jobs/*` mit `CRON_TOKEN` |
| Google Calendar | vorhanden (`src/integrations/google.ts`), OAuth-Tokens verschlüsselt in der LifeOS-DB |
| Notion | **fehlt** |
| Tests / CI | 35 Vitest-Dateien, CI: lint · typecheck · test · build · gitleaks |
| Host | Ubuntu 24.04, kein Node auf dem Host (nur im Container), Minecraft als Docker-Container `minecraft` (`/opt/minecraft`), `playit.service`, `tailscaled` |

## Entscheidungen

1. **Eigener Prozess auf dem Host, gleicher Stack.** Der Agent braucht `systemctl`, `journalctl`, Docker (über einen Helfer) und die `claude`-CLI – das geht nicht aus dem gehärteten Container (`cap_drop: ALL`). Code liegt in `src/agent/`, TypeScript, gestartet mit Node 24 und eingebautem Type-Stripping (`node src/agent/main.ts`) – kein Build-Schritt, kein `tsx`. Dafür importiert der Agent relativ mit `.ts`-Endung (`allowImportingTsExtensions` in `tsconfig.json`) und nutzt keine Next-Module.
2. **Eigene SQLite-Datei `agent.db`** (Default `/var/lib/lifeos-agent`), gleiches Muster wie `src/lib/db.ts` (`node:sqlite`, WAL, `user_version`-Migrationen). Die LifeOS-DB gehört dem Container; zwei Prozesse mit verschiedenen Nutzern auf einer Datei wären fragil.
3. **Kalender über LifeOS statt zweitem Google-Client:** neuer Endpunkt `GET /api/jobs/agent-briefing` (Bearer `CRON_TOKEN`, wie `mail-triage`) liefert heutige Termine aus dem bestehenden `google`-Integration-Code. Bis das neue Image deployt ist, meldet das Briefing „Kalender nicht erreichbar“ statt abzubrechen.
4. **Notion:** neuer schlanker Client (`fetch`, kein SDK) mit `NOTION_TOKEN` + `NOTION_TASKS_DB_ID`. Views sind über die API nicht abfragbar – „Heute“ wird nachgebaut: Status ≠ erledigt und Datum ≤ heute (überfällig = „nicht erledigt“-Liste). Property-Namen per Config.
5. **Keine neuen Runtime-Dependencies.** Telegram Bot API, Ollama, Notion per `fetch`; Cron-Parser selbst geschrieben (5 Felder, Zeitzone über `zonedToEpoch` aus `src/lib/time.ts`). Zod ist schon da.
6. **Server-Aktionen über einen Root-Helfer** (`/usr/local/lib/lifeos-agent/helper`, root-owned) mit festen Verben und eigener Whitelist (`/etc/lifeos-agent/helper.conf`). `sudoers` erlaubt dem Nutzer `lifeos` nur diesen Helfer. Lesen von systemd-Status/Journal ohne sudo (Gruppe `systemd-journal`).
7. **Telegram-Formatierung:** HTML-Parse-Mode (nur `& < >` escapen, robuster als MarkdownV2). LLM-Markdown wird in ein kleines HTML-Subset übersetzt; lehnt Telegram ab → Klartext.
8. **Claude nur über die CLI** (`claude -p --output-format stream-json --verbose --model <alias> --tools "" …`), eigene Installation für den Nutzer `lifeos`, Auth über `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/lifeos-agent/agent.env`. Der Agent liest das Token nie, er reicht nur die Umgebung an die CLI weiter und entfernt `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
9. **API-Provider** existiert mit demselben Interface, `ENABLE_API_PROVIDER=false`. Eigener Key-Name `AGENT_ANTHROPIC_API_KEY` (echter API-Key, nie das Abo-Token), Monatsbudget und Preise aus Config, ohne Preise verweigert er den Dienst.

## Architektur

```
Telegram (Long Polling) ─► gateway.ts ─ Whitelist · Rate-Limit · Befehle · Buttons
                                │
                                ▼
                           router.ts ─ Regeln → Ollama-Klassifikation → Provider-Wahl → Eskalation
                             │      └─► providers/{ollama,claude,api}.ts
                             ▼
                           tools/ ─ feste Funktionen, Zod-Parameter, confirm.ts (Buttons, 5 Min) → audit
                                │
scheduler.ts (agent.db) ────────┴─► jobs/{briefing,health}.ts ─► Telegram
```

## Dateien

```
src/agent/
  main.ts               Einstieg: Config, DB, Startprüfungen, Polling, Scheduler, Health-Endpunkt
  config.ts             Zod-Schema für die Agent-Umgebung
  db.ts                 agent.db + Migrationen
  log.ts                Konsole (journald) + rotierendes Datei-Log
  telegram/api.ts       Bot-API-Client (getUpdates, sendMessage, Buttons …)
  telegram/format.ts    HTML-Escape, Markdown→HTML, Splitten auf 4096 Zeichen
  gateway.ts            Update-Verarbeitung, Whitelist, Rate-Limit, Befehle
  router.ts             Regeln, Klassifikation, Provider/Modell, Eskalation, Routing-Log
  providers/types.ts    Provider-Interface
  providers/ollama.ts   lokales Modell
  providers/claude.ts   `claude -p` (stream-json, Kontingent-Erkennung)
  providers/api.ts      deaktivierter API-Provider (Budget, Kostenlog)
  quota.ts              Kontingent-Status + persistente Queue
  tools/system.ts       CPU/RAM/Disk/Uptime/Temperatur aus /proc und /sys
  tools/exec.ts         execFile ohne Shell, Helfer-Aufrufe, Dry-Run
  tools/registry.ts     alle Tools mit Parametern, Art, Vorschau
  tools/intents.ts      deterministische Erkennung („Status“, „Starte Minecraft neu“ …)
  confirm.ts            Bestätigungs-Flow + Audit-Log
  scheduler/cron.ts     Cron parsen, beschreiben, nächste Ausführung (Europe/Berlin)
  scheduler/parse.ts    „jeden Freitag um 16 Uhr …“ → Cron
  scheduler/scheduler.ts Jobs ausführen, nachholen (≤ 1 h), Standard-Jobs anlegen
  jobs/briefing.ts      Morgen-Briefing (Notion, Kalender, Server-Zeile)
  jobs/health.ts        Health-Checks, Drosselung, Tageszusammenfassung
  integrations/notion.ts
  integrations/lifeos.ts
src/app/api/jobs/agent-briefing/route.ts   Kalender + LifeOS-Überblick für das Briefing
deploy/agent/           lifeos-agent.service, ollama-Override, helper.sh, helper.conf, sudoers, agent.env.example
scripts/install_agent.sh
tests/agent/*.test.ts
```

## Offene Punkte für Luis

- Telegram-Bot-Token und User-ID eintragen, `claude setup-token` als Nutzer `lifeos` ausführen, optional Notion-Token.
- LifeOS-Image neu bauen/deployen, damit `/api/jobs/agent-briefing` existiert (sonst Briefing ohne Kalender).
