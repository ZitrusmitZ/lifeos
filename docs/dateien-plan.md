# Plan: „Dateien“ – Nextcloud-Oberfläche in LifeOS

> **Stand 2026-10-23:** Phasen 1–4 umgesetzt (Branch `feat/dateien`). Abweichungen vom Plan: PDFs werden nicht im Browser
> angezeigt, sondern heruntergeladen (fremde Inhalte laufen nie unter der LifeOS-Adresse); unterbrochene Uploads merkt sich
> `localStorage` statt IndexedDB (die Datei selbst wählt man zum Fortsetzen erneut). Offen: Phase 2 (Bezüge zu Schule/Noten/Lernen,
> Ordner als ZIP teilen).

Stand 2026-10-22 · Ziel: Nextcloud im Alltag nicht mehr direkt öffnen müssen. Durchsuchen, per Drag & Drop hochladen
und per Link teilen, im LifeOS-Look (iOS-Karten, `ios-rows`, `SwipeRow`, `Segmented`) mit MediaFire-Anleihen
(große Drop-Zone, Upload-Warteschlange mit Fortschritt, ein Klick für den Link, eigene Download-Seite mit Zähler).

## Entscheidungen (von Luis)

- **Teilen auch mit Fremden**: Öffentlich wird nur die Download-Seite `/d/<token>` über Tailscale Funnel.
  Dashboard und Nextcloud bleiben im Tailnet.
- **Dateien bis mehrere GB**: Upload in Stücken (Chunks) über die Chunked-Upload-v2-API von Nextcloud, mit Fortschritt und Fortsetzen.
- **Ordnerstruktur**: siehe `~/homeserver/nextcloud-ordner.sh`. Uploads ohne Ziel landen in `00 Eingang` (bisher `LifeOS-Uploads`).

## Aufbau

### 1. Client-Erweiterung `src/lib/homeserver/nextcloud.ts`
- `list(path)`: PROPFIND mit Depth 1, gibt Ordner **und** Dateien zurück. `parseDavFiles` bekommt eine Option, die Ordner nicht mehr verwirft.
- `mkdir`, `move`/`rename`, `delete` (in den Papierkorb, wie Nextcloud es macht), `download(path)` als Stream (mit Range-Header für große Dateien und Video).
- `preview(fileId, size)` über `/index.php/core/preview?fileId=…` für Bild-Thumbnails.
- Chunked Upload: `startUpload()` → MKCOL `/remote.php/dav/uploads/<user>/<id>`, `putChunk(id, n, body)`, `finishUpload(id, ziel)` → MOVE auf `.file` mit `Destination` und `OC-Total-Length`. `uploadPath()` prüft weiterhin jedes Ziel.
- Tests in `tests/nextcloud.test.ts` mit gefakten WebDAV-Antworten, wie bisher.

### 2. API-Routen (nur im Tailnet, wie alles andere hinter `src/proxy.ts`)
- `GET /api/files?path=` listet einen Ordner, `POST /api/files` legt Ordner an, verschiebt, benennt um oder löscht.
- `POST /api/files/upload` startet einen Upload und gibt eine Upload-ID zurück. `PUT /api/files/upload/<id>/<n>` streamt einen Chunk von 10 MB
  direkt an Nextcloud weiter, ohne ihn zu puffern. `POST …/<id>/done` setzt die Datei zusammen.
  Der Browser spricht nie selbst mit Nextcloud, das App-Passwort bleibt auf dem Server.
- `GET /api/files/raw?path=` dient für Download und Vorschau.
- Das bisherige Upload-Limit von 10 MB (Server Action) gilt nur noch für das Widget. Die Seite nutzt Chunks.

### 3. Teilen (MediaFire-Teil)
- Neue Tabelle `file_shares` mit token (32 Byte, zufällig), path, file_id, created_at, expires_at, password_hash (optional, scrypt), max_downloads (optional), downloads und revoked_at.
  Eigene Links statt Nextcloud-Public-Shares, weil die Nextcloud-Share-Seite viele Assets nachlädt und sich nicht sauber auf einen Funnel-Pfad begrenzen lässt.
- `/d/[token]`: serverseitig gerendert, **ohne Client-JS und mit Inline-CSS**. Zeigt Dateiname, Größe, Typ-Icon, Vorschau bei Bildern, einen großen Download-Button und „läuft ab in …“.
  Bei Passwort kommt erst ein Formular. `/d/[token]/download` streamt mit Range-Support und zählt mit.
- In `src/proxy.ts` ist `/d/` von der Anmeldung ausgenommen. Mit Rate-Limit pro IP, ungültige Tokens bekommen ein einheitliches 404.
- Funnel: `tailscale funnel --bg --https=10000 --set-path=/d http://127.0.0.1:3000/d`. Öffentlich ist **nur** `/d/*`.
  Port 443 (LifeOS) und 8443 (Nextcloud) bleiben reine Tailnet-Dienste.
- Neue Env-Variable `SHARE_PUBLIC_URL=https://homeserver.taila65db2.ts.net:10000`, daraus wird der Link gebaut.
- Standardwerte beim Teilen: Ablauf nach 7 Tagen (wählbar: 1 Tag, 7 Tage, 30 Tage, nie), kein Passwort. Ordner teilen kommt in Phase 2 (als ZIP-Stream).

### 4. Seite `/dateien` (`src/app/dateien/page.tsx` + `src/components/files/*`)
- **Kopf**: Breadcrumb des Pfads, Suchfeld (WebDAV SEARCH nach Namen) und rechts der Speicherbalken aus `quota`/`info`.
- **Schnellzugriff** als Kacheln: Eingang, Schule → aktuelles Halbjahr, Musik, Fotos, Dokumente und „Geteilt“ (aktive Links).
- **Drop-Zone**: Die ganze Seite nimmt Dateien an, auch Ordner per `webkitGetAsEntry`, dann bleibt die Unterstruktur erhalten.
  Beim Drüberziehen erscheint ein Overlay „Nach /01 Schule/… ablegen“. Auf dem Handy gibt es stattdessen den Button „Hochladen“ (Kamera/Dateien).
- **Upload-Warteschlange** (MediaFire-Stil) als einklappbares Panel unten rechts, auf dem Handy als Sheet:
  pro Datei Fortschritt, Geschwindigkeit, Restzeit, Pause/Abbrechen und bei Fehlern „Erneut“. Es laufen höchstens 3 Dateien parallel.
  Den Fortschritt merkt sich IndexedDB, nach einem Reload geht es ab dem letzten Chunk weiter.
  Ist der Name schon belegt, wird nachgefragt: „Umbenennen (Datei (2).pdf)“ oder „Überspringen“. Überschrieben wird nie stillschweigend.
- **Dateiliste** im `ios-rows`-Stil mit Typ-Icon bzw. Thumbnail, Name, Größe und „vor 2 h“.
  Wisch-Aktionen über `SwipeRow`: Teilen und Löschen. Auf dem Desktop zusätzlich ein Kontextmenü und Mehrfachauswahl.
  Umschalter Liste/Raster über `Segmented`, das Raster für Fotos.
- **Drag & Drop innerhalb**: Dateien auf einen Ordner oder Breadcrumb ziehen verschiebt sie.
- **Teilen-Sheet**: Ablauf wählen, optional ein Passwort, dann „Link kopieren“ mit Haptik und Toast. Auf dem Handy öffnet sich das native Share-Sheet (`navigator.share`).
  Unter „Geteilt“ stehen alle Links mit Downloadzahl, jeder lässt sich widerrufen.
- **Vorschau**: Bilder, PDFs (eingebettet), Audio (wichtig für Bounces) und Video im Overlay.
- Navigation: Eintrag „Dateien“ in der Seitenleiste bzw. Tab-Bar. Das Nextcloud-Widget verlinkt auf `/dateien`, `/server` behält nur Status und Admin-Kram.

### 5. Agent
- Neue Tools `nextcloud_list` (nur lesen, automatisch erlaubt) und `nextcloud_share` (Schreibzugriff, braucht wie alle Writes den „Ausführen“-Button).
  Damit kann der Agent z. B. „Schick mir einen Link zum Mathe-Übungsblatt“ erledigen.

### 6. LifeOS-Bezüge (Phase 2)
- In `/schule` und `/noten` je Fach ein Link „Dateien“, der zu `01 Schule/<aktuelles Halbjahr>/<Fach>` springt. Das Halbjahr kommt aus einer Einstellung.
- Zum Halbjahreswechsel bietet LifeOS an, `Q2 (11-2)` mit allen Fächern anzulegen.
- In `/lernen` lassen sich Lernmaterialien direkt aus Nextcloud wählen.

## Reihenfolge / PRs
1. Client + Tests (list, mkdir, move, delete, download, chunked upload).
2. API-Routen + Seite `/dateien` mit Liste, Navigation und Drop-Upload mit Warteschlange.
3. Teilen: Tabelle, `/d/[token]`, Proxy-Ausnahme, Rate-Limit, Teilen-Sheet. Danach richtet Luis den Funnel ein (sudo).
4. Vorschau, Raster, Suche, Agent-Tools.
5. Phase 2: Bezüge zu Schule/Noten/Lernen, Ordner-ZIP.

## Offene Punkte
- Eine Bandbreitenbremse für Funnel-Downloads? Der Upload deines Anschlusses ist die Grenze.
- Soll `LifeOS-Uploads` nach `00 Eingang` verschoben werden? Das Skript verschiebt nichts.
