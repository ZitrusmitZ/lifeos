# Fähigkeiten: Island ↔ LifeOS-Agent

Stand 25.10.2026 (Dateien von der Island, Sprachantwort in Telegram ergänzt). Diese Liste ist der Vertrag: Was hier „beide“ hat, muss über die Island (Laptop) **und** über den
LifeOS-Agent (Telegram, Web-Chat) gehen. Die einzige gewollte Ausnahme sind Stufe 0/1, also das Bedienen des Laptops.

**Warum Parität fast von selbst gilt:** Die Island führt nur Stufe 0/1 selbst aus. Alles ab Stufe 2 schickt islandd als
Nachricht an den LifeOS-Agent (`POST /api/agent/sessions/<Island-Sitzung>`, mit der Routing-Entscheidung von Luis-Jev).
Dort läuft derselbe Gateway wie für Telegram und den Web-Chat: dieselben Werkzeuge, Freigaben, das Gedächtnis und der
Fallback. Damit Telegram ohne Modell genauso einordnet, liest der Agent dieselbe Vocab-Liste wie die Island
(`luis-jev.json`, vom Laptop mit `island/deploy/agent-skills/sync-agent-skills.sh` nach `LUISJEV_FILE` synchronisiert).

| Fähigkeit | Island | Agent (Telegram/Web) | Beleg |
|---|:-:|:-:|---|
| **Stufe 0**: Lautstärke, Medien, Apps, Fenster, Nicht stören, Dunkelmodus, Playlists | ✓ | – (gewollt: Laptop) | `computah/tests/test_router_l0.py`, `test_fast_path.py` |
| **Stufe 1**: in Apps klicken (AT-SPI, Texterkennung), gelernte Abläufe | ✓ | – (gewollt: Laptop) | `computah/tests/test_workflow.py`, `test_procedures.py` |
| **Ketten** in einem Satz, auch ohne „und/dann“, ✓/?/✗ pro Schritt | ✓ | ✓ (`splitChain`) | `computah/tests/test_router_chain.py`, `tests/agent/luis-jev.test.ts` |
| **Stufe 2**: schnelle Fragen (Lernplan, News, Wissen) | ✓ (an den Agent) | ✓ | `tests/agent/router.test.ts` |
| **Stufe 3**: Plan-Modus → Freigabe → Ziel-Schleife | ✓ (Plan-Karte, Freigabe per Klick) | ✓ (Buttons `p:<id>:y\|n`, Text überarbeitet) | `tests/agent/luis-jev.test.ts` |
| **Server**: Status, Logs, Neustart, Backup, Deploy, root-Befehl (mit Tipp) | ✓ (an den Agent) | ✓ | `tests/agent/confirm.test.ts`, `deploy-tasks.test.ts`, `root-coder.test.ts` |
| **Coding-Agent** (`code_start` → Worktree → PR) | ✓ (an den Agent, Coder in der Übersicht) | ✓ | `tests/agent/root-coder.test.ts` |
| **Connectors** (Gmail, Kalender, Notion …), ändernde Aktionen nur mit Freigabe | ✓ (an den Agent) | ✓ | `tests/agent/connectors.test.ts` |
| **Web**: Seite lesen, Websuche (Obscura) | ✓ (`web.search`/`web.open` am Laptop oder an den Agent) | ✓ (`web_read`, `web_search`) | `tests/agent/obscura.test.ts` |
| **LifeOS-Daten**: Habits, Erinnerungen, Karteikarten, Noten, Gesundheit, **Lesen** (`get_reading`) | ✓ (an den Agent) | ✓ (LifeOS-MCP) | `tests/mcp-lifeos.test.ts` |
| **Lesen öffnen**: „weiterlesen“ → Buch an der letzten Stelle | ✓ (`reading.open` → `/lesen/weiter`) | ✓ (Link aus `get_reading`) | `computah/tests/test_router.py`, `tests/reading.test.ts` |
| **Gedächtnis**: Profil, claude-mem, Verlauf über Modellwechsel hinweg | ✓ (gleicher Agent) | ✓ | `tests/agent/memory.test.ts` |
| **Freigaben** aus allen Kanälen sehen und entscheiden | ✓ (`/api/agent/feed`, Karte) | ✓ (Buttons) | `island/tests/test_lifeos.py`, `tests/agent/web.test.ts` |
| **Berechtigungsmodus** (Standard / Auto / Nur lesen) | ✓ (liest `permissions` aus `/feed`, schaltet) | ✓ (Dashboard) | `tests/agent/permissions.test.ts` |
| **Pro-Kontingent leer**: weiter **mit Werkzeugen** über FreeLLM (gleiche Claude-Code-Sitzung) | ✓ (gleicher Agent) | ✓ | `tests/agent/agent-mode.test.ts`, `claude.test.ts`, `free.test.ts` |
| **Dateien** annehmen und in Nextcloud einsortieren | ✓ (📎 in der Eingabe, `island send --file`, Nautilus „An LifeOS-Agent senden“) | ✓ (Telegram-Anhang, Web-Upload) | `island/tests/test_lifeos.py`, `tests/agent/uploads.test.ts` |
| **Sprache** | ✓ (Mikrofon, **Gespräch Strg+Alt+G** mit gesprochenen Ergebnissen und Unterbrechen) | ✓ (Telegram-Sprachnachricht → FreeLLM-STT → wie getippt; Antwort zusätzlich als Sprachnachricht, Piper lokal) | `computah/tests/test_listening.py`, `tests/agent/voice.test.ts`, `tests/agent/tts.test.ts` |

## Bekannte Lücken

- **Sprachantwort im Web-Chat:** Nur Telegram bekommt eine Sprachnachricht zurück; der Web-Chat zeigt Text.
- **Ordner von der Island:** Es gehen nur Dateien (≤ 10, je ≤ 10 MB), keine ganzen Ordner.
- **Stufe 0/1 aus Telegram:** gewollt nicht möglich. Der Laptop ist nur von der Island aus steuerbar, nicht vom Server aus.

## Prüfen

```bash
npx vitest run tests/agent tests/mcp-lifeos.test.ts tests/reading.test.ts      # LifeOS
(cd ~/AIStack/island/computah && ../.venv/bin/python -m pytest tests -q)       # Island
```

Am lebenden System: `routing_log` in `agent.db` zeigt bei leerem Kontingent `provider = free` mit Werkzeug-Aufrufen,
`computah history` zeigt pro Kettenschritt ein eigenes Ergebnis.
