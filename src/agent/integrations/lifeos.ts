/**
 * Kalender-Termine aus dem LifeOS-Container (der besitzt die Google-Tokens): `GET /api/jobs/agent-briefing`
 * mit dem vorhandenen `CRON_TOKEN`. So gibt es nur einen Google-Client im Repo.
 */

export type AgentEvent = { title: string; start: string; end: string; allDay: boolean; location: string | null; calendar: string };
export type AgentBriefingData = { day: string; events: AgentEvent[] | null; calendarStatus: "ok" | "unconfigured" | "error"; hint?: string };

export async function fetchLifeosBriefing(url: string, token: string, fetchFn: typeof fetch = fetch): Promise<AgentBriefingData> {
  const res = await fetchFn(`${url.replace(/\/$/, "")}/api/jobs/agent-briefing`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new Error("LifeOS-Endpunkt fehlt – neues Image deployen");
  if (!res.ok) throw new Error(`LifeOS antwortet mit ${res.status}`);
  return (await res.json()) as AgentBriefingData;
}
