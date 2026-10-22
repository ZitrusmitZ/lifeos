import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { FileBrowser, type Storage } from "@/components/files/file-browser";
import { PageHeader } from "@/components/page-header";
import { WidgetSkeleton } from "@/components/widget-card";
import { loadNextcloud } from "@/integrations/loaders";
import { isDemo } from "@/lib/env";
import { FilesError, listFolder, message } from "@/lib/files/service";
import { nextcloudConfigured, nextcloudPublicUrl } from "@/lib/homeserver/clients";

export const metadata: Metadata = { title: "Dateien" };

async function Content({ searchParams }: { searchParams: PageProps<"/dateien">["searchParams"] }) {
  await connection();
  if (!isDemo() && !nextcloudConfigured()) {
    return (
      <p className="rounded-[20px] bg-card p-4 text-subhead text-muted-foreground">
        Nextcloud ist noch nicht verbunden – NEXTCLOUD_URL, NEXTCLOUD_USER und NEXTCLOUD_APP_PASSWORD in der .env eintragen.
      </p>
    );
  }
  const raw = (await searchParams).pfad;
  const wanted = typeof raw === "string" ? raw : "/";
  const [listing, nc, failure] = await Promise.all([
    listFolder(wanted).catch(async (err) => {
      // Ordner weg (umbenannt, gelöscht) → Hauptordner statt Fehlerseite
      if (err instanceof FilesError && err.status === 404 && wanted !== "/") return listFolder("/");
      throw err;
    }),
    loadNextcloud(),
    null,
  ]).catch((err: unknown) => [null, null, message(err)] as const);
  if (!listing) {
    return <p className="rounded-[20px] bg-critical/10 p-4 text-subhead text-critical">{failure ?? "Nextcloud nicht erreichbar"}</p>;
  }
  const storage: Storage | null =
    nc && nc.status === "ok"
      ? { usedBytes: nc.data.quota.usedBytes, totalBytes: nc.data.quota.totalBytes, freeBytes: nc.data.info?.freeBytes ?? null }
      : null;
  return <FileBrowser initial={listing} storage={storage} demo={isDemo()} />;
}

export default function FilesPage(props: PageProps<"/dateien">) {
  const nc = nextcloudPublicUrl();
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Dateien"
        trailing={
          nc ? (
            <a
              href={`${nc}/apps/files/`}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center gap-1 rounded-full px-2 text-body text-tint-text active:opacity-60"
            >
              Nextcloud <ExternalLink className="size-4" aria-hidden />
            </a>
          ) : null
        }
      />
      <Suspense fallback={<WidgetSkeleton lines={8} />}>
        <Content searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}
