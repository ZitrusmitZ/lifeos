/** Aufbau der Heute-Seite: Reihenfolge und Darstellung je Widget (groß, kompakte Kachel oder aus). */

export const WIDGETS = {
  school: "Schule",
  exams: "Klausuren & Tests",
  habits: "Gewohnheiten",
  weather: "Wetter",
  calendar: "Termine",
  mail: "Mail-Assistent",
  inbox: "Posteingang",
  health: "Gesundheit",
  news: "Nachrichten",
  music: "Musik",
  github: "GitHub",
  cards: "Karteikarten",
  reading: "Lesen",
  grades: "Noten",
  pihole: "Pi-hole",
  cloud: "Nextcloud",
  webwerk: "Webwerk",
} as const;

export type WidgetId = keyof typeof WIDGETS;
export type WidgetMode = "large" | "compact" | "hidden";
export type DashboardLayout = { id: WidgetId; mode: WidgetMode }[];

export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];
export const WIDGET_MODES: WidgetMode[] = ["large", "compact", "hidden"];

/** Was heute zählt, steht groß oben; der Rest als Kacheln, die beim Antippen aufklappen. */
export const DEFAULT_LAYOUT: DashboardLayout = [
  { id: "school", mode: "large" },
  { id: "exams", mode: "large" },
  { id: "habits", mode: "large" },
  { id: "weather", mode: "large" },
  { id: "calendar", mode: "large" },
  { id: "mail", mode: "compact" },
  { id: "inbox", mode: "compact" },
  { id: "health", mode: "compact" },
  { id: "news", mode: "compact" },
  { id: "music", mode: "compact" },
  { id: "github", mode: "compact" },
  { id: "cards", mode: "compact" },
  { id: "reading", mode: "compact" },
  { id: "grades", mode: "compact" },
  { id: "pihole", mode: "compact" },
  { id: "cloud", mode: "compact" },
  { id: "webwerk", mode: "compact" },
];

/** Gespeichertes Layout bereinigen: unbekannte/doppelte Einträge raus, neue Widgets mit Standard hinten an. */
export function normalizeLayout(raw: unknown): DashboardLayout {
  const seen = new Set<WidgetId>();
  const out: DashboardLayout = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = (item as { id?: unknown })?.id;
      const mode = (item as { mode?: unknown })?.mode;
      if (typeof id !== "string" || !(id in WIDGETS) || seen.has(id as WidgetId)) continue;
      seen.add(id as WidgetId);
      out.push({ id: id as WidgetId, mode: WIDGET_MODES.includes(mode as WidgetMode) ? (mode as WidgetMode) : "compact" });
    }
  }
  for (const d of DEFAULT_LAYOUT) if (!seen.has(d.id)) out.push(d);
  return out;
}

export function moveWidget(layout: DashboardLayout, id: WidgetId, by: -1 | 1): DashboardLayout {
  const i = layout.findIndex((w) => w.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= layout.length) return layout;
  const next = [...layout];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function setWidgetMode(layout: DashboardLayout, id: WidgetId, mode: WidgetMode): DashboardLayout {
  return layout.map((w) => (w.id === id ? { ...w, mode } : w));
}
