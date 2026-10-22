import { FileText } from "lucide-react";
import { loadNextcloud } from "@/integrations/loaders";
import { formatSize } from "@/lib/drive/policy";
import { relativeTime } from "@/lib/time";
import { ResultView, WidgetCard } from "../widget-card";

export async function NextcloudWidget({ className }: { className?: string }) {
  const result = await loadNextcloud();
  return (
    <WidgetCard title="Nextcloud" href="/dateien" hrefLabel="Dateien" className={className}>
      <ResultView result={result} integration="nextcloud">
        {(c) => {
          const free = c.info?.freeBytes ?? null;
          const total = free !== null ? free + c.quota.usedBytes : null;
          const pct = total ? Math.max(1, Math.round((c.quota.usedBytes / total) * 100)) : null;
          return (
            <div className="space-y-4">
              <div>
                <p className="font-heading text-title1 leading-none font-bold tabular-nums">
                  {formatSize(c.quota.usedBytes)}
                  <span className="ml-1.5 text-subhead font-semibold text-muted-foreground">belegt</span>
                </p>
                {pct !== null && free !== null ? (
                  <>
                    <div
                      className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label="Belegung der Nextcloud-Platte"
                    >
                      <div className="h-full rounded-full bg-tint" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1.5 text-footnote text-muted-foreground">{formatSize(free)} frei · Nextcloud {c.status.version}</p>
                  </>
                ) : (
                  <p className="mt-1 text-footnote text-muted-foreground">Nextcloud {c.status.version}</p>
                )}
              </div>
              {c.recent.length ? (
                <ul className="ios-rows text-subhead">
                  {c.recent.slice(0, 3).map((f) => (
                    <li key={f.path} className="flex items-center gap-3 py-1.5">
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {f.url ? (
                        <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate active:opacity-70">
                          {f.name}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      )}
                      <span className="shrink-0 text-footnote text-muted-foreground">{relativeTime(f.modifiedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-subhead text-muted-foreground">Noch keine Dateien.</p>
              )}
            </div>
          );
        }}
      </ResultView>
    </WidgetCard>
  );
}
