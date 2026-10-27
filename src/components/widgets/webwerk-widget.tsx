import { loadWebwerk } from "@/integrations/loaders";
import { ResultView, WidgetCard } from "../widget-card";

export const euro = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** `YYYY-MM-DDTHH:MM` (Berlin) → „heute 16:30“ / „Do. 10:00“ */
function when(startsAt: string, today: string): string {
  const [day, time] = startsAt.split("T");
  if (day === today) return `heute ${time}`;
  const weekday = new Date(`${day}T12:00:00Z`).toLocaleDateString("de-DE", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${time}`;
}

export async function WebwerkWidget({ className }: { className?: string }) {
  const result = await loadWebwerk();
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  return (
    <WidgetCard
      title="Webwerk"
      href={result.status === "ok" ? result.data.url : undefined}
      hrefLabel="Cockpit"
      className={className}
    >
      <ResultView result={result} integration="webwerk">
        {(w) => (
          <div className="space-y-4">
            <div className="flex items-end gap-6">
              <div>
                <p className="font-heading text-title1 leading-none font-bold tabular-nums">
                  {w.todo}
                  <span className="ml-1.5 text-subhead font-semibold text-muted-foreground">heute zu tun</span>
                </p>
                <p className="mt-1.5 text-footnote text-muted-foreground">
                  {w.revenueMonth || w.openSum ? `${euro(w.revenueMonth)} Umsatz im Monat · ${euro(w.openSum)} offen` : "Noch kein Umsatz in diesem Monat"}
                </p>
              </div>
            </div>
            {w.overdue.length || w.inquiries.length || w.appointments.length ? (
              <ul className="ios-rows text-subhead">
                {w.overdue.slice(0, 2).map((d) => (
                  <li key={d.href} className="flex items-center gap-3 py-1.5">
                    <span className="shrink-0 text-footnote font-semibold text-critical">Überfällig</span>
                    <a href={d.href} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate active:opacity-70">
                      {d.number} · {d.company}
                    </a>
                    <span className="shrink-0 text-footnote text-muted-foreground tabular-nums">{euro(d.amount)}</span>
                  </li>
                ))}
                {w.inquiries.slice(0, 3).map((r) => (
                  <li key={r.href} className="flex items-center gap-3 py-1.5">
                    <span className={r.urgent ? "shrink-0 text-footnote font-semibold text-critical" : "shrink-0 text-footnote font-semibold text-tint-text"}>
                      {r.urgent ? "Dringend" : "Anfrage"}
                    </span>
                    <a href={r.href} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate active:opacity-70">
                      {r.title} – {r.company}
                    </a>
                  </li>
                ))}
                {w.appointments.slice(0, 2).map((a) => (
                  <li key={`${a.startsAt}${a.title}`} className="flex items-center gap-3 py-1.5">
                    <span className="shrink-0 text-footnote text-muted-foreground tabular-nums">{when(a.startsAt, today)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {a.title}
                      {a.company ? ` · ${a.company}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-subhead text-muted-foreground">Keine Anfragen, Termine oder offenen Rechnungen.</p>
            )}
          </div>
        )}
      </ResultView>
    </WidgetCard>
  );
}
