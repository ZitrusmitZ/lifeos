import type { Metadata } from "next";
import { Cloud, ExternalLink, FileText, ShieldCheck } from "lucide-react";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import {
  NextcloudUploadForm,
  PiholeBlockingControls,
  PiholeDomainForm,
  PiholeDomainList,
  PiholeGravityButton,
} from "@/components/homeserver";
import { PageHeader } from "@/components/page-header";
import { RefreshButton } from "@/components/refresh-button";
import { ResultView, WidgetSkeleton } from "@/components/widget-card";
import { loadNextcloud, loadPihole } from "@/integrations/loaders";
import { formatSize } from "@/lib/drive/policy";
import { nextcloudPublicUrl, piholeAdminUrl } from "@/lib/homeserver/clients";
import { UPLOAD_DIR } from "@/lib/homeserver/nextcloud";
import { relativeTime } from "@/lib/time";

export const metadata: Metadata = { title: "Server" };

const n = (v: number) => v.toLocaleString("de-DE");

function Section({ id, title, icon, action, children }: { id: string; title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-16 space-y-3 desktop:scroll-mt-20">
      <h2 id={`${id}-title`} className="flex min-h-11 items-center gap-1.5 px-1 text-title3 font-bold tracking-tight">
        {icon}
        {title}
        <span className="ml-auto flex items-center">{action}</span>
      </h2>
      {children}
    </section>
  );
}

const Card = ({ title, children }: { title?: string; children: ReactNode }) => (
  <div className="space-y-3 rounded-[20px] bg-card p-4">
    {title ? <h3 className="text-body font-semibold">{title}</h3> : null}
    {children}
  </div>
);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] bg-muted px-3 py-2.5">
      <p className="font-heading text-title3 leading-tight font-bold tabular-nums">{value}</p>
      <p className="text-footnote text-muted-foreground">{label}</p>
    </div>
  );
}

function OpenLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-1 rounded-full px-2 text-body text-tint-text active:opacity-60">
      {label}
      <ExternalLink className="size-4" aria-hidden />
    </a>
  );
}

async function PiholeSection() {
  await connection();
  const result = await loadPihole();
  return (
    <Section
      id="pihole"
      title="Pi-hole"
      icon={<ShieldCheck className="size-5 text-good" aria-hidden />}
      action={
        <>
          <RefreshButton integration="pihole" />
          <OpenLink href={piholeAdminUrl()} label="Admin" />
        </>
      }
    >
      <ResultView result={result} integration="pihole">
        {(p) => (
          <div className="space-y-3">
            <Card>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Anfragen heute" value={n(p.summary.queries)} />
                <Stat label="Geblockt" value={`${n(p.summary.blocked)} · ${n(p.summary.percentBlocked)} %`} />
                <Stat label="Aktive Geräte" value={n(p.summary.activeClients)} />
                <Stat label="Domains auf Blocklisten" value={n(p.summary.domainsOnBlocklist)} />
              </div>
              <p className="text-subhead">
                {p.blocking.enabled ? "Werbeblocker ist an." : p.blocking.timer ? "Werbeblocker ist pausiert." : "Werbeblocker ist aus."}
              </p>
              <PiholeBlockingControls enabled={p.blocking.enabled} timer={p.blocking.timer} />
            </Card>

            {p.topBlocked.length ? (
              <Card title="Am häufigsten geblockt">
                <ul className="ios-rows text-subhead">
                  {p.topBlocked.map((d) => (
                    <li key={d.domain} className="flex min-h-11 items-center gap-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate">{d.domain}</span>
                      <span className="text-footnote text-muted-foreground tabular-nums">{n(d.count)}×</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <Card title="Eigene Freigaben und Sperren">
              <PiholeDomainList domains={p.domains} />
              <div className="border-t border-border pt-3">
                <PiholeDomainForm />
              </div>
            </Card>

            <Card title="Blocklisten">
              <p className="text-subhead text-muted-foreground">
                {p.summary.gravityUpdatedAt ? `Zuletzt aktualisiert ${relativeTime(p.summary.gravityUpdatedAt * 1000)}.` : "Noch nie aktualisiert."} Pi-hole lädt
                die Listen sonntags von selbst neu.
              </p>
              <PiholeGravityButton />
            </Card>
          </div>
        )}
      </ResultView>
    </Section>
  );
}

async function NextcloudSection() {
  await connection();
  const result = await loadNextcloud();
  return (
    <Section
      id="nextcloud"
      title="Nextcloud"
      icon={<Cloud className="size-5 text-tint-text" aria-hidden />}
      action={
        <>
          <RefreshButton integration="nextcloud" />
          <OpenLink href={nextcloudPublicUrl()} label="Öffnen" />
        </>
      }
    >
      <ResultView result={result} integration="nextcloud">
        {(c) => (
          <div className="space-y-3">
            <Card>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Belegt" value={formatSize(c.quota.usedBytes)} />
                <Stat label="Frei auf der Platte" value={c.info?.freeBytes != null ? formatSize(c.info.freeBytes) : "–"} />
                <Stat label="Quota" value={c.quota.totalBytes ? `${n(c.quota.percent ?? 0)} % von ${formatSize(c.quota.totalBytes)}` : "unbegrenzt"} />
                <Stat label="Version" value={c.status.version} />
              </div>
              {c.status.needsDbUpgrade ? <p className="text-subhead text-warning">Nextcloud braucht ein Datenbank-Upgrade (occ upgrade).</p> : null}
              {!c.info ? (
                <p className="text-footnote text-muted-foreground">Platz und Dateizahl brauchen einen Admin-Nutzer mit der App „serverinfo“.</p>
              ) : null}
            </Card>

            <Card title="Zuletzt geändert">
              {c.recent.length ? (
                <ul className="ios-rows text-subhead">
                  {c.recent.map((f) => (
                    <li key={f.path} className="flex min-h-11 items-center gap-3 py-1.5">
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        {f.url ? (
                          <a href={f.url} target="_blank" rel="noreferrer" className="block truncate font-medium active:opacity-70">
                            {f.name}
                          </a>
                        ) : (
                          <p className="truncate font-medium">{f.name}</p>
                        )}
                        <p className="truncate text-footnote text-muted-foreground">
                          {f.path.split("/").slice(0, -1).join("/") || "/"} · {formatSize(f.size)}
                        </p>
                      </div>
                      <span className="shrink-0 text-footnote text-muted-foreground">{relativeTime(f.modifiedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-subhead text-muted-foreground">Noch keine Dateien.</p>
              )}
            </Card>

            <Card title="Hochladen">
              <p className="text-subhead text-muted-foreground">Vorhandene Dateien werden nie überschrieben.</p>
              <NextcloudUploadForm defaultFolder={UPLOAD_DIR} />
            </Card>
          </div>
        )}
      </ResultView>
    </Section>
  );
}

export default function ServerPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Server" back={{ href: "/settings", label: "Einstellungen" }} />
      <Suspense fallback={<WidgetSkeleton lines={6} />}>
        <PiholeSection />
      </Suspense>
      <Suspense fallback={<WidgetSkeleton lines={6} />}>
        <NextcloudSection />
      </Suspense>
    </div>
  );
}
