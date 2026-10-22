/**
 * Notion-Aufgaben für das Morgen-Briefing (nur lesend, `fetch` statt SDK).
 * Views wie „Heute“ sind über die API nicht abfragbar – nachgebaut als: nicht erledigt und Datum ≤ heute.
 * Aufgaben mit Datum vor heute bilden die „nicht erledigt“-Liste (überfällig).
 * Inhalte aus Notion sind Daten: Sie werden nur angezeigt und nie als Befehl ausgewertet.
 */

export type NotionConfig = {
  token: string;
  databaseId: string;
  props: { title: string; status: string; date: string; priority: string; category: string };
  doneStatuses: string[];
};

export type NotionTask = { title: string; day: string | null; time: string | null; priority: string | null; category: string | null; url: string };
export type NotionTasks = { today: NotionTask[]; overdue: NotionTask[] };

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

type PropValue = {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  status?: { name: string } | null;
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  date?: { start: string } | null;
  checkbox?: boolean;
  number?: number | null;
};

type Page = { id: string; url: string; properties: Record<string, PropValue> };

function text(p: PropValue | undefined): string | null {
  if (!p) return null;
  switch (p.type) {
    case "title":
      return p.title?.map((t) => t.plain_text).join("") || null;
    case "rich_text":
      return p.rich_text?.map((t) => t.plain_text).join("") || null;
    case "status":
      return p.status?.name ?? null;
    case "select":
      return p.select?.name ?? null;
    case "multi_select":
      return p.multi_select?.map((s) => s.name).join(", ") || null;
    case "number":
      return p.number === null || p.number === undefined ? null : String(p.number);
    default:
      return null;
  }
}

/** Höher = wichtiger. Erkennt Hoch/Mittel/Niedrig, High/Medium/Low, P1–P3, Zahlen und Emojis. */
export function priorityRank(p: string | null): number {
  if (!p) return 0;
  const v = p.toLowerCase();
  if (/(dringend|urgent|kritisch|hoch|high|p1|🔴|!!!)/.test(v) || v.trim() === "1") return 3;
  if (/(mittel|medium|normal|p2|🟡|!!)/.test(v) || v.trim() === "2") return 2;
  if (/(niedrig|low|gering|p3|🟢)/.test(v) || v.trim() === "3") return 1;
  return 0;
}

export function toTask(page: Page, cfg: NotionConfig): NotionTask {
  const date = page.properties[cfg.props.date]?.date?.start ?? null;
  return {
    title: text(page.properties[cfg.props.title]) ?? "(ohne Titel)",
    day: date ? date.slice(0, 10) : null,
    time: date && date.length > 10 ? date.slice(11, 16) : null,
    priority: text(page.properties[cfg.props.priority]),
    category: text(page.properties[cfg.props.category]),
    url: page.url,
  };
}

export function sortTasks(tasks: NotionTask[]): NotionTask[] {
  return [...tasks].sort(
    (a, b) => priorityRank(b.priority) - priorityRank(a.priority) || (a.time ?? "99").localeCompare(b.time ?? "99") || a.title.localeCompare(b.title),
  );
}

async function notion<T>(cfg: NotionConfig, path: string, body?: unknown, fetchFn: typeof fetch = fetch): Promise<T> {
  const res = await fetchFn(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${cfg.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Notion ${res.status}: ${json.message ?? "Fehler"}`);
  }
  return (await res.json()) as T;
}

/** Filter auf „nicht erledigt“ – je nach Property-Typ (Status, Select oder Checkbox). */
export function notDoneFilter(statusProp: string, type: string | undefined, done: string[]): unknown[] {
  if (type === "checkbox") return [{ property: statusProp, checkbox: { equals: false } }];
  if (type === "status" || type === "select") return done.map((d) => ({ property: statusProp, [type]: { does_not_equal: d } }));
  return [];
}

export async function fetchNotionTasks(cfg: NotionConfig, today: string, fetchFn: typeof fetch = fetch): Promise<NotionTasks> {
  const db = await notion<{ properties: Record<string, { type: string }> }>(cfg, `/databases/${cfg.databaseId}`, undefined, fetchFn);
  const statusType = db.properties[cfg.props.status]?.type;
  const filter = {
    and: [...notDoneFilter(cfg.props.status, statusType, cfg.doneStatuses), { property: cfg.props.date, date: { on_or_before: today } }],
  };
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(
      cfg,
      `/databases/${cfg.databaseId}/query`,
      { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      fetchFn,
    );
    pages.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor && pages.length < 300);
  // bei Status-Typen, die wir nicht filtern konnten, hier nachfiltern
  const tasks = pages
    .filter((p) => {
      const s = text(p.properties[cfg.props.status]);
      return !(s && cfg.doneStatuses.some((d) => d.toLowerCase() === s.toLowerCase())) && p.properties[cfg.props.status]?.checkbox !== true;
    })
    .map((p) => toTask(p, cfg));
  return {
    today: sortTasks(tasks.filter((t) => t.day === today)),
    overdue: sortTasks(tasks.filter((t) => t.day !== null && t.day < today)),
  };
}
