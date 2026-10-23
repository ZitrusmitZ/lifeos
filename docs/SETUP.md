# LifeOS einrichten

Diese Anleitung führt durch alles, was nur du selbst erledigen kannst: Zugänge anlegen, Schlüssel eintragen und die Geräte verbinden. Reihenfolge: VPS → Tailscale → `.env` → OAuth-Verbindungen → iPhone-Kurzbefehl.

> **Platzhalter:** `<tailnet>` ist dein Tailnet-Name (`taila65db2.ts.net`), die Dashboard-URL lautet also `https://lifeos.taila65db2.ts.net`.

---

## 1. VPS vorbereiten

1. Frisches **Ubuntu 24.04** (2 vCPU / 4 GB RAM reichen, LifeOS braucht ~150–250 MB).
2. Den SSH-Schlüssel des Laptops beim Anbieter hinterlegen (oder per `ssh-copy-id root@<öffentliche-IP>`).
3. In der [Tailscale-Admin-Konsole](https://login.tailscale.com/admin/machines) den alten Eintrag `vps-6a3e96a0` löschen, damit der neue Server den Namen `lifeos` bekommt.
4. Unter **DNS** prüfen, dass **MagicDNS** und **HTTPS Certificates** aktiviert sind (wird für `tailscale serve` gebraucht).
5. Optional: das GHCR-Paket öffentlich machen (GitHub → *Packages* → `lifeos` → *Package settings* → **Public**). Nicht nötig, wenn `gh` auf dem VPS eingeloggt ist – das Skript meldet Docker dann mit deinem GitHub-Login bei GHCR an.

Dann auf dem VPS (als normaler Nutzer mit sudo):

```bash
gh auth login --web -s read:packages        # Gerätecode im Browser bestätigen
sudo git clone https://github.com/ZitrusmitZ/lifeos /opt/lifeos
sudo bash /opt/lifeos/deploy/bootstrap-vps.sh
```

Das Skript installiert Docker, Tailscale und die GitHub CLI aus den offiziellen Paketquellen, richtet Firewall (UFW) und automatische Sicherheitsupdates ein, erzeugt `ENCRYPTION_KEY` und `INGEST_TOKEN`, startet den Container und veröffentlicht ihn per `tailscale serve` **nur im Tailnet**. Ist Tailscale noch nicht verbunden, erscheint ein Login-Link – im Browser öffnen und bestätigen. Updates holt sich der Server danach selbst (`git pull` + neues Image alle 10 Minuten).

Zum Schluss, **nachdem** du dich einmal über Tailscale verbunden hast (`ssh ubuntu@lifeos`):

```bash
sudo --preserve-env=SSH_CLIENT bash /opt/lifeos/deploy/bootstrap-vps.sh --lockdown-ssh
```

Ab dann ist der VPS aus dem Internet gar nicht mehr erreichbar (kein offener Port außer Tailscales UDP-Port).

---

## 2. `.env` ausfüllen

```bash
sudo nano /opt/lifeos/.env
cd /opt/lifeos && sudo docker compose up -d --no-build
```

| Variable | Woher |
|---|---|
| `ALLOWED_TAILSCALE_USERS` | `owner` (Standard): nur der Tailscale-Nutzer, dem der Server gehört – übersteht Umbenennungen des Logins. Alternativ Nutzer-IDs oder Logins wie `name@github`, kommagetrennt. |
| `UNTIS_SERVER` / `UNTIS_SCHOOL` | Aus der WebUntis-Adresse im Browser: `https://<SERVER>/WebUntis/?school=<SCHULE>`. |
| `UNTIS_USER` / `UNTIS_PASSWORD` | Dein normaler WebUntis-Login. |
| `GITHUB_TOKEN` | Siehe Abschnitt 5. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Siehe Abschnitt 3. |
| `SPOTIFY_CLIENT_ID` | Siehe Abschnitt 4. |
| `PIHOLE_*` / `NEXTCLOUD_*` | Siehe Abschnitt 5a. |

Nach jeder Änderung: `sudo docker compose up -d --no-build` (startet den Container mit der neuen Konfiguration neu).

---

## 3. Google (Kalender, Gmail, Drive – nur lesend)

1. [Google Cloud Console](https://console.cloud.google.com/) → neues Projekt **LifeOS**.
2. *APIs & Dienste → Bibliothek*: **Google Calendar API**, **Gmail API** und **Google Drive API** aktivieren.
3. *OAuth-Zustimmungsbildschirm* (Google Auth Platform): Typ **Extern**, App-Name „LifeOS“, deine E-Mail als Support- und Entwickleradresse.
   - Unter *Zielgruppe* dich selbst als Testnutzer eintragen.
   - Danach **„App veröffentlichen“ / In Produktion** – im Testmodus laufen die Refresh-Tokens nach 7 Tagen ab. Eine Verifizierung ist für die eigene Nutzung nicht nötig; beim Login erscheint dann „Google hat diese App nicht überprüft“ → *Erweitert* → *Weiter zu LifeOS*.
4. *Clients → Client erstellen*: Typ **Webanwendung**, autorisierte Weiterleitungs-URI:
   `https://lifeos.<tailnet>/api/auth/google/callback`
5. Client-ID und Client-Secret in die `.env`, Container neu starten.
6. Im Dashboard: **Einstellungen → Mit Google verbinden**.

Benötigte Berechtigungen: `calendar.readonly` + `calendar.events` (Termine anlegen), `gmail.modify` (Mail-Assistent: Labels setzen, archivieren, in den Papierkorb legen) und `drive` (Drive aufräumen: Dateien in den Papierkorb legen und wiederherstellen). LifeOS sendet keine Mails und löscht nie endgültig. Fehlen einem schon verbundenen Konto neue Rechte, zeigt *Einstellungen → Google* „Neu verbinden für …“.

---

### Mail-Assistent

Der Assistent sortiert um 06:00 und 16:00 alle verbundenen Postfächer (Timer `lifeos-mail.timer`):

- **Schutz zuerst:** markierte Mails und Sicherheits-/Login-Mails werden nie angefasst; Schule, Finanzen, Konten und persönliche Mails bleiben immer im Posteingang.
- **Regeln:** eigene und gelernte Absender-Regeln (Einstellungen → Mail-Assistent) greifen vor der KI.
- **KI** (`gpt-6-luna`): bekommt nur Absender, Betreff und die Gmail-Vorschau (max. 220 Zeichen). Eindeutige Werbung/Spam → Papierkorb (30 Tage wiederherstellbar), Infos ohne Handlungsbedarf → Archiv, Unsicheres → Widget „Mail-Assistent“ zur Entscheidung.
- **Lernen:** jede Entscheidung und jedes „Rückgängig“ wird als Absender-Regel gespeichert.
- **Kosten:** Monatsdeckel `OPENAI_MONTHLY_BUDGET_USD` (Standard 1 $); bei ~150 Mails/Tag fallen grob 0,10–0,20 $ an.

Einrichten: `OPENAI_API_KEY` in die `.env` (Key unter [platform.openai.com/api-keys](https://platform.openai.com/api-keys), dort am besten auch ein Monatslimit setzen), Container neu starten. Google-Konten, die vor dem Mail-Assistenten verbunden wurden, einmal **neu verbinden** (Gmail braucht jetzt Schreibrechte). Weitere Konten: Einstellungen → „Weiteres Google-Konto verbinden“.

Manuell auslösen: Knopf „Jetzt sortieren“ im Widget oder `sudo systemctl start lifeos-mail`.

---

## 4. Spotify

> Seit Februar 2026 brauchen Spotify-Entwickler-Apps ein **Spotify-Premium-Konto** des App-Besitzers; pro Entwickler ist eine App mit bis zu 5 Nutzern erlaubt. LifeOS nutzt nur Endpunkte, die im Development Mode weiterhin verfügbar sind.

1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → *Create app*.
2. Redirect URI: `https://lifeos.<tailnet>/api/auth/spotify/callback`, API: **Web API**.
3. Die **Client ID** in die `.env` (`SPOTIFY_CLIENT_ID`). Ein Client-Secret ist nicht nötig (PKCE).
4. Im Dashboard: **Einstellungen → Mit Spotify verbinden**.

---

## 5. GitHub

1. Vorausgefüllt öffnen (Name, 1 Jahr Laufzeit, nur Leserechte – `<user>` ersetzen):
   `https://github.com/settings/personal-access-tokens/new?name=LifeOS+Dashboard&target_name=<user>&expires_in=366&contents=read&pull_requests=read&statuses=read&actions=read`
2. *Repository access*: **All repositories** (lässt sich nicht vorausfüllen; nötig, damit private Repos mit CI-Status erscheinen). Permissions: **Contents, Pull requests, Commit statuses, Actions** – jeweils Read-only (Metadata kommt automatisch).
3. Token als `GITHUB_TOKEN` in die `.env`, dann `sudo docker compose up -d --no-build`.

## 5a. Pi-hole & Nextcloud (Homeserver)

Voraussetzung: Pi-hole und Nextcloud laufen per Docker Compose auf demselben Server (Container `pihole` und `nextcloud` im Netz `homeserver_default`). LifeOS spricht sie intern an – es werden keine Ports geöffnet.

1. **LifeOS ins Netz hängen** – in `/opt/lifeos/compose.override.yaml` (lokal, nicht im Repo):
   ```yaml
   services:
     lifeos:
       networks: [default, homeserver]
   networks:
     homeserver:
       external: true
       name: homeserver_default
   ```
2. **Pi-hole-App-Passwort:** Pi-hole-Oberfläche → *Einstellungen* → *Web-Oberfläche/API* → *Erweitert* → **App-Passwort konfigurieren**, kopieren, *Speichern*. In die `.env`: `PIHOLE_URL=http://pihole`, `PIHOLE_APP_PASSWORD=…`.
3. **Nextcloud-App-Passwort** (Admin-Nutzer, sonst fehlen Speicherangaben):
   ```bash
   cd ~/homeserver && sudo docker compose exec -u www-data nextcloud php occ user:auth-tokens:add <nutzer>
   sudo docker compose exec -u www-data nextcloud php occ config:system:set trusted_domains 5 --value=nextcloud
   ```
   In die `.env`: `NEXTCLOUD_URL=http://nextcloud`, `NEXTCLOUD_USER=<nutzer>`, `NEXTCLOUD_APP_PASSWORD=…`.
4. **HTTPS im Tailnet (optional, für Links):** `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080` und `sudo tailscale serve --bg --https=8444 http://127.0.0.1:8081`, dann `NEXTCLOUD_PUBLIC_URL=https://<host>.<tailnet>.ts.net:8443` und `PIHOLE_PUBLIC_URL=https://<host>.<tailnet>.ts.net:8444`. Nextcloud braucht dafür zusätzlich `trusted_domains` mit `<host>.<tailnet>.ts.net:8443`, `overwriteprotocol=https` und `trusted_proxies`.
5. `cd /opt/lifeos && sudo docker compose up -d --no-build`. Unter *Einstellungen → Server* erscheinen Pi-hole und Nextcloud.

### Dateien (`/dateien`) und Freigabe-Links

Unter **Dateien** (Ordner-Symbol in der Kopfleiste, Nextcloud-Widget, *Einstellungen*) lässt sich die Nextcloud durchsuchen, per Drag & Drop befüllen (auch ganze Ordner und Dateien mit mehreren GB – in 8-MB-Stücken, fortsetzbar) und ordnen. Löschen verschiebt in den Nextcloud-Papierkorb.

**Teilen:** LifeOS erzeugt eigene Links `/d/<token>` mit Ablauf (1/7/30 Tage oder nie), optionalem Passwort und Download-Zähler. Damit auch Leute ohne Tailscale sie öffnen können, läuft neben LifeOS der kleine Container **`lifeos-share`** (Profil `share` in `compose.yaml`). Er meldet sich als eigenes Gerät im Tailnet an und gibt per Funnel **nur `/d/`** weiter.

> **Nie Funnel auf dem Server-Namen selbst.** Funnel trägt den Namen ins öffentliche DNS ein (und Tailscale entfernt den Eintrag danach nur verzögert). Browser mit eigenem DNS – iCloud Privat-Relay, Brave „Sicheres DNS“ – landen dann beim Funnel-Relay statt im Tailnet: Das Dashboard zeigt `ERR_SSL_PROTOCOL_ERROR` bzw. die Home-Bildschirm-App bleibt weiß. Deshalb der eigene Name `lifeos-share`.

1. **Access controls** (https://login.tailscale.com/admin/acls): Tag anlegen und Funnel **nur** für diesen Tag erlauben:
   ```json
   "tagOwners": { "tag:share": ["autogroup:admin"] },
   "nodeAttrs": [ { "target": ["tag:share"], "attr": ["funnel"] } ]
   ```
2. **Auth-Key** (https://login.tailscale.com/admin/settings/keys → *Generate auth key*): *Reusable* aus, *Ephemeral* aus, *Pre-approved* an (falls Geräte-Freigabe aktiv), *Tags* → `tag:share`. Ablauf egal (wird nur für die erste Anmeldung gebraucht; danach liegt der Schlüssel des Geräts im Volume `share-state`).
3. In `/opt/lifeos/.env`:
   ```
   COMPOSE_PROFILES=share
   SHARE_TS_AUTHKEY=tskey-auth-…
   SHARE_PUBLIC_URL=https://lifeos-share.<tailnet>.ts.net
   ```
4. `cd /opt/lifeos && sudo docker compose up -d --no-build` – startet `lifeos-share` und LifeOS mit der neuen Link-Adresse.
5. Nach der ersten Anmeldung `SHARE_TS_AUTHKEY` wieder leeren (die `.env` landet auch im LifeOS-Container; der Key wird nicht mehr gebraucht).
6. Prüfen: `sudo docker logs lifeos-share` zeigt die Anmeldung; `https://lifeos-share.<tailnet>.ts.net/d/<irgendwas>` liefert die LifeOS-Seite „Link nicht gültig“, `https://lifeos-share.<tailnet>.ts.net/` nur 404.

Ohne Schritt 1–4 funktionieren die Links nur im Tailnet.

Was öffentlich ist: die Download-Seite (ohne JavaScript, kein Zugriff auf `/_next`), der Download selbst und bei Bildern ein Vorschaubild. Dashboard, `/api/files` und Nextcloud bleiben hinter der Tailnet-Anmeldung. Unbekannte, abgelaufene und widerrufene Links antworten gleich (404); Seitenaufrufe und Passwortversuche sind pro IP begrenzt.

Ordnerstruktur anlegen (einmalig, legt nur Ordner an): `sudo bash ~/homeserver/nextcloud-ordner.sh`. Uploads ohne Ziel landen in `00 Eingang`.

**Agent:** Die Tools `pihole_*`, `nextcloud_status`, `nextcloud_list`, `nextcloud_search` und `nextcloud_share` (öffentlicher Link, nur nach Bestätigung) laufen über `GET/POST /api/jobs/homeserver` mit `LIFEOS_CRON_TOKEN` – der Agent braucht keine eigenen Zugangsdaten. Für Status, Logs und Neustart der Container `pihole`, `nextcloud` und `nextcloud-db` in `/etc/lifeos-agent/helper.conf` bei `ALLOWED_DOCKER` und in `agent.env` bei `AGENT_SERVICES` ergänzen.

---

## 6. iPhone-Kurzbefehl (Apple Health → LifeOS)

Das iPhone muss mit Tailscale verbunden sein (Tailscale-App, VPN an).

1. App **Kurzbefehle** → *Automation* → *Neue Automation* → **Tageszeit**, z. B. 22:30, täglich, **Sofort ausführen**.
2. Aktionen hinzufügen:
   1. **Health-Samples suchen**: Typ *Schritte*, Startdatum *heute*, gruppieren nach *Tag* → danach **Statistiken berechnen: Summe** (Ergebnis: *Schritte*).
   2. Genauso für *Aktive Energie* (Summe), *Trainingsminuten* (Summe), *Ruheherzfrequenz* (Durchschnitt).
   3. **Health-Samples suchen**: *Schlafanalyse*, Startdatum *gestern 18:00*, Wert *Im Bett/Schlafend* → **Statistiken berechnen: Summe** → in Stunden umrechnen (**Berechnen: ÷ 3600**, falls Sekunden).
   4. **Wörterbuch**: Schlüssel `steps`, `energy`, `workout`, `heart`, `sleep` mit den Variablen von oben (Typ Zahl).
   5. **Inhalte von URL abrufen**:
      - URL: `https://lifeos.<tailnet>/api/ingest/health`
      - Methode: **POST**
      - Header: `Authorization` = `Bearer <INGEST_TOKEN aus der .env>`
      - Anfragetext: **JSON** → das Wörterbuch.
3. Einmal manuell testen: Die Antwort sollte `{"ok":true,"day":"…","saved":5}` sein.

Zahlen mit Komma („7,5“), Tausenderpunkt („8.432“) oder als Liste werden automatisch verstanden. Optional `date` im Format `JJJJ-MM-TT` mitschicken, sonst gilt der heutige Tag.

Testen ohne iPhone:

```bash
curl -X POST https://lifeos.<tailnet>/api/ingest/health \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"steps": 8432, "sleep": 7.5, "workout": 45}'
```

---

## 7. Auf dem iPhone/iPad als App

Safari → `https://lifeos.<tailnet>` → Teilen → **Zum Home-Bildschirm**. Für den Wetter-Standort einmal oben im Wetter-Widget auf *Standort* tippen und erlauben.

**Habit-Erinnerungen (Push):** LifeOS vom Home-Bildschirm öffnen → *Gewohnheiten* → *Erinnerungen* → **Mitteilungen aktivieren** und erlauben (iOS 16.4 oder neuer; in Safari selbst bietet iOS das nicht an). Danach bei einer Gewohnheit über den Stift eine Uhrzeit setzen. Ist sie zu dieser Zeit noch offen, kommt eine Mitteilung – höchstens eine pro Tag und Gewohnheit. Die Nachrichten laufen über Apples Push-Dienst und kommen auch an, wenn Tailscale auf dem iPhone gerade aus ist; zum Öffnen der App braucht es Tailscale wie immer. Die nötigen VAPID-Schlüssel erzeugt LifeOS selbst und speichert sie verschlüsselt in der Datenbank – in der `.env` ist nichts einzutragen.

**Mails öffnen:** Unter *Einstellungen → Google* wählen, wohin ein Tipp auf eine Mail führt: **Apple Mail** (springt direkt zur Mail, wenn das Konto in der Mail-App eingerichtet ist), **Gmail-App** (öffnet die App; Google bietet keinen Link auf einzelne Mails) oder **Browser**.

---

## 8. Claude anbinden (MCP)

LifeOS bringt zwei MCP-Server mit, beide nur im Tailnet erreichbar:

| Server | Adresse | Kann |
|---|---|---|
| `untis` | `/api/mcp` | Stundenplan, Ausfälle, Klausuren, Hausaufgaben – nur lesen |
| `lifeos` | `/api/mcp/lifeos` | Habits, Erinnerungen, Karteikarten, Noten, Lernpläne, Gesundheit – lesen **und eintragen** (abhaken, Erinnerung/Karten/Note anlegen). Löschen geht bewusst nicht. |

```bash
claude mcp add --transport http untis https://lifeos.<tailnet>/api/mcp
claude mcp add --transport http lifeos https://lifeos.<tailnet>/api/mcp/lifeos
```

Danach z. B.: „Was steht heute an?“, „Hak Vokabeln ab“, „Erinner mich morgen um 17 Uhr an das Bio-Referat“, „Mach mir aus diesem Text 20 Karteikarten in einen neuen Stapel Biologie“, „Trag 11 Punkte in der Mathe-Klausur ein“. Schreibende Tools sind als solche markiert – Claude fragt vor dem Ausführen nach.

---

## 9. Island (Laptop)

Die „Island“ auf dem Laptop (GNOME-Shell-Extension + Daemon `islandd`, Repo `~/AIStack/island`) zeigt offene Freigaben und laufende Coding-Agents an, entscheidet per Klick und gibt Sprachbefehle weiter. Sie spricht LifeOS unter `APP_URL` an (z. B. `https://home.<tailnet>.ts.net`) – Zugriff wie beim Dashboard über die Tailscale-Identität (`ALLOWED_TAILSCALE_USERS`), kein eigener Token.

| Route | Zweck |
|---|---|
| `GET /api/agent/feed?since=<ms>` | Offene Freigaben **aller** Chats (Telegram und Web: Bestätigungen `c:`, Job-Vorschläge `j:`, Connector-/Root-Freigaben `a:`), Coding-Agents, Unterhaltungen, die gerade antworten. `pending` ist immer vollständig – per Telegram Entschiedenes fehlt beim nächsten Poll. `since` gilt nur für `coders` (laufende plus seit `since` geänderte, Standard: letzte 24 h). |
| `POST /api/agent/action` | `{data}` mit `allow`/`deny` aus dem Feed – dieselben Daten wie die Buttons |
| `POST /api/agent/sessions` + `…/messages` | Aufgaben an den Agenten in einer eigenen Web-Unterhaltung |
| `POST /api/jev` | `{state, questions}` → TypeSafe Jev über OpenRouter (Ersatz für das alte VPS-Relay, gleiches Antwortformat) |
| `POST /api/stt?lang=de&prompt=…` | Body `audio/wav` (max. 30 s / 2 MB) → `{text, ms}` über Groq Whisper, ohne `GROQ_API_KEY` über FreeLLM (`{text, ms, via}`) |

In `/opt/lifeos/.env` eintragen (siehe `.env.example`), dann `docker compose up -d --no-build`:

```bash
OPENROUTER_API_KEY=sk-or-…   # openrouter.ai → Keys
GROQ_API_KEY=gsk_…           # console.groq.com → API Keys (optional, siehe FreeLLM)
```

Ohne `OPENROUTER_API_KEY` antwortet `/api/jev` mit 503 (`jev_not_configured`). Ohne `GROQ_API_KEY` schickt `/api/stt` das Audio an den Agenten (`POST /stt` auf dem Web-Socket), der FreeLLMAPI auf dem Host fragt (`FREE_LLM_KEY` in `agent.env`, Modell `FREE_LLM_STT_MODEL`, Standard `whisper-1`) – kostenlos, kein weiterer Schlüssel in dieser `.env`; der Container selbst erreicht `127.0.0.1:3001` des Hosts nicht. Fehlt auch das (oder läuft ein Agent ohne `/stt`), kommt 503 `stt_not_configured`, bei FreeLLM-Fehlern 502 `freellm_unavailable`; die Island fällt dann auf lokales Whisper zurück. Groq und Jev prüfen vorher das KI-Monatsbudget (402 `budget_exceeded`); gebucht wird in `llm_usage` (`purpose` `jev` bzw. `stt`, FreeLLM mit 0 $ und Modell `freellm:<Anbieter>`).

Der Feed kommt vom Agenten (`GET /feed` auf dem Web-Socket): nach einem Update des Agenten (`scripts/install_agent.sh`) ist er da; ohne neuen Agenten antwortet `/api/agent/feed` mit 404.

---

## Betrieb

| Aufgabe | Befehl (auf dem VPS, in `/opt/lifeos`) |
|---|---|
| Status / Logs | `docker compose ps` · `docker compose logs -f` |
| Manuell aktualisieren | `sudo systemctl start lifeos-update` (läuft sonst alle 10 min) |
| Backup jetzt | `sudo deploy/backup.sh` (läuft sonst täglich 03:30, 14 Tage Aufbewahrung in `data/backups/`) |
| Wiederherstellen | `docker compose down && rm -f data/lifeos.db-wal data/lifeos.db-shm && cp data/backups/lifeos-JJJJ-MM-TT.db data/lifeos.db && docker compose up -d --no-build` |
| Tailscale-Freigabe prüfen | `tailscale serve status` |
