import { ShieldCheck, ShieldOff } from "lucide-react";
import { loadPihole } from "@/integrations/loaders";
import { PiholeBlockingControls } from "../homeserver";
import { ResultView, WidgetCard } from "../widget-card";

const n = (v: number) => v.toLocaleString("de-DE");

export async function PiholeWidget({ className }: { className?: string }) {
  const result = await loadPihole();
  return (
    <WidgetCard title="Pi-hole" href="/server#pihole" hrefLabel="Server" className={className}>
      <ResultView result={result} integration="pihole">
        {(p) => (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {p.blocking.enabled ? (
                <ShieldCheck className="size-8 shrink-0 text-good" aria-hidden />
              ) : (
                <ShieldOff className="size-8 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="font-heading text-title1 leading-none font-bold tabular-nums">
                  {n(p.summary.percentBlocked)} %
                  <span className="ml-1.5 text-subhead font-semibold text-muted-foreground">geblockt</span>
                </p>
                <p className="mt-1 text-footnote text-muted-foreground">
                  {n(p.summary.blocked)} von {n(p.summary.queries)} Anfragen heute · {p.summary.activeClients} Geräte
                </p>
              </div>
            </div>
            {p.topBlocked.length ? (
              <ul className="ios-rows text-subhead">
                {p.topBlocked.slice(0, 3).map((d) => (
                  <li key={d.domain} className="flex items-center gap-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{d.domain}</span>
                    <span className="text-footnote text-muted-foreground tabular-nums">{n(d.count)}×</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <PiholeBlockingControls enabled={p.blocking.enabled} timer={p.blocking.timer} compact />
          </div>
        )}
      </ResultView>
    </WidgetCard>
  );
}
