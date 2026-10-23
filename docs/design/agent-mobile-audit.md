# Agent-Chat mobil: Audit und Umbau (iPhone/iPad)

Messung mit `scripts/agent-screenshots.mjs` (Playwright/Chromium, Demo-Modus, `/agent` und `/agent/1`). Gerätegrößen: iPhone SE 375×667, iPhone 15 393×852,
iPhone 16 Pro Max 440×956, iPad hoch 820×1180 und quer 1180×820; hell und dunkel; mit „Tastatur“ = Viewport um 260–420 px verkleinert und Eingabe fokussiert.
Vorher: `docs/screenshots/agent-before-*`, nachher: `docs/screenshots/agent-after-*`. Der Demo-Modus liefert jetzt Beispiel-Unterhaltungen (`src/lib/agent-demo.ts`).

Grenze der Messung: Chromium hat keine echte Bildschirmtastatur und kein iOS-Verhalten des `visualViewport`. Die iOS-Logik wurde mit einem simulierten
`visualViewport` geprüft (`agent-after-ios-sim-tastatur.png`, `agent-after-sheet-tastatur.png`); echte Geräte siehe PR-Beschreibung.

## Mängel (vorher)

| # | Mangel | Beleg |
|---|--------|-------|
| 1 | Die Seite scrollt als Ganzes (`scrollHeight` 1668–2057 px bei 667–1180 px Fensterhöhe). Das Eingabefeld ist nur `sticky`; Nachrichten scheinen unter Eingabe und Tab-Leiste durch. | `agent-before-15-chat-light-tastatur.png`, `…ipad-quer-chat-light.png` |
| 2 | Tastatur: Auf iOS bleibt der Layout-Viewport gleich, Safari schiebt die Seite. Eingabe und Kopfzeile wandern aus dem Bild, die Tab-Leiste hängt über der Tastatur. Kein `visualViewport`-Ausgleich. | `…-tastatur.png` (Tab-Leiste über Eingabe) |
| 3 | `autoFocus` auf `/agent/<id>` auch auf Touch → Tastatur springt beim Öffnen auf (Fokus = `TEXTAREA` ohne Tipp). | Messwert `focus` in der Konsolenausgabe |
| 4 | Enter sendet auch auf dem Handy; Zeilenumbruch nur mit Shift (existiert dort nicht). | Code |
| 5 | Neue Nachrichten scrollen immer ans Ende (`scrollIntoView`), auch beim Lesen alter Nachrichten. Kein „nach unten“-Knopf. | Code |
| 6 | Fehler beim Senden: Nachricht verschwindet, Text wandert ins Feld zurück. | Code |
| 7 | Kein Entwurf bei Tab-Wechsel/Neuladen. | Code |
| 8 | Keine Kopierfunktion (Auswahl nicht gezielt erlaubt), URLs nicht antippbar, kein Kopieren an Codeblöcken. | Code |
| 9 | Tippflächen unter 44 pt: Aktions-Buttons in Bubbles (`size="sm"`, 36 px), „Anhang entfernen“ (24 px), „Neu“ im Sheet. | Code |
| 10 | `aria-live` auf der ganzen Liste → VoiceOver liest bei jedem Poll mit. | Code |
| 11 | Schriftgröße im Eingabefeld ok (17 px), Höhe über `field-sizing` (fehlt in älterem Safari). | Code |
| 12 | Sheet: Inhalt scrollt samt Eingabe; Tastatur-Ausgleich nur über Polster, Eingabe wandert aus dem sichtbaren Bereich. | Code |
| 13 | Fehler-/Offline-Zustand nur als kleine graue Zeile; Leerzustand ein Textblock. | `agent-before-*-chat-*` |
| 14 | iPad (Touch, ohne Maus): `desktop`-Variante greift nicht, also keine Zwei-Spalten-Ansicht; Zeilen über die ganze Breite (1180 px) schwer lesbar. | `agent-before-ipad-quer-chat-light.png` |

## Umbau

- **Layout:** `/agent/<id>` ist auf Touch eine feste 100dvh-Spalte (Kopfzeile, scrollender Verlauf mit `overscroll-contain`, angedocktes Eingabefeld) über der Tab-Leiste;
  am Desktop bleibt es die rechte Spalte. Das Chat-Sheet nutzt dieselbe Spalte (`Sheet fill`).
- **Tastatur:** `src/lib/use-keyboard-inset.ts` (reine Funktion `computeKeyboardInset`, getestet). Container, Sheet, Tab-Leiste und Chat-Knopf folgen dem sichtbaren Bereich;
  `interactive-widget=resizes-content` im Viewport (Zoom bleibt erlaubt).
- **iPad:** Touch-iPad nutzt wie das iPhone Liste → Unterhaltung (Vollbild-Spalte, Inhalt auf 48 rem begrenzt). Die Zwei-Spalten-Ansicht gibt es mit Maus/Trackpad
  (`desktop`-Variante, z. B. iPad mit Magic Keyboard). Bewusst nicht geändert: ein Split auf reinem Touch würde Tastatur-Höhe und Tab-Leiste in beiden Ausrichtungen komplizierter machen.
- Verhalten, Barrierefreiheit und Zustände: siehe PR-Beschreibung.
