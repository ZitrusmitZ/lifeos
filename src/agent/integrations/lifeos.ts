/**
 * Kalender-Termine aus dem LifeOS-Container (der besitzt die Google-Tokens): `GET /api/jobs/agent-briefing`
 * mit dem vorhandenen `CRON_TOKEN`. So gibt es nur einen Google-Client im Repo.
 */

export type AgentEvent = { title: string; start: string; end: string; allDay: boolean; location: string | null; calendar: string };
export type AgentBriefingData = {
  day: string;
  events: AgentEvent[] | null;
  /** nur mit `days`: Termine pro Tag ab heute */
  days?: { day: string; events: AgentEvent[] }[];
  calendarStatus: "ok" | "unconfigured" | "error";
  hint?: string;
};

/** `days` (1–7): zusätzlich Termine pro Tag ab heute, für das Kalender-Tool im Chat. */
export async function fetchLifeosBriefing(url: string, token: string, fetchFn: typeof fetch = fetch, days?: number): Promise<AgentBriefingData> {
  const query = days ? `?days=${days}` : "";
  const res = await fetchFn(`${url.replace(/\/$/, "")}/api/jobs/agent-briefing${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new Error("LifeOS-Endpunkt fehlt – neues Image deployen");
  if (!res.ok) throw new Error(`LifeOS antwortet mit ${res.status}`);
  return (await res.json()) as AgentBriefingData;
}
