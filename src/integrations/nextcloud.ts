import "server-only";
import { nextcloudClient, nextcloudConfigured } from "@/lib/homeserver/clients";
import type { NextcloudFile, NextcloudQuota, NextcloudServerInfo, NextcloudStatus } from "@/lib/homeserver/nextcloud";
import { IntegrationError, type Integration } from "./core";

export type NextcloudData = {
  status: NextcloudStatus;
  /** `null`, wenn serverinfo fehlt oder der Nutzer kein Admin ist – der Rest bleibt nutzbar */
  info: NextcloudServerInfo | null;
  quota: NextcloudQuota;
  recent: (NextcloudFile & { url: string | null })[];
};

export const nextcloud: Integration<NextcloudData> = {
  id: "nextcloud",
  ttlSeconds: 5 * 60,
  missingConfig: () =>
    nextcloudConfigured()
      ? null
      : { hint: "NEXTCLOUD_URL, NEXTCLOUD_USER und NEXTCLOUD_APP_PASSWORD in .env eintragen", connectHref: "/settings#nextcloud" },
  async fetch() {
    const client = nextcloudClient();
    if (!client) throw new IntegrationError("Nextcloud nicht eingerichtet");
    const status = await client.status();
    if (!status.installed) throw new IntegrationError("Nextcloud ist noch nicht eingerichtet");
    if (status.maintenance) throw new IntegrationError("Nextcloud ist im Wartungsmodus");
    const [info, quota, recent] = await Promise.all([client.serverInfo().catch(() => null), client.quota(), client.recentFiles(8)]);
    return { status, info, quota, recent: recent.map((f) => ({ ...f, url: client.fileUrl(f) })) };
  },
  mock() {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const file = (id: number, path: string, size: number, h: number, contentType: string) => ({
      id,
      name: path.split("/").at(-1) as string,
      path,
      size,
      modifiedAt: ago(h),
      contentType,
      url: null,
    });
    return {
      status: { installed: true, maintenance: false, needsDbUpgrade: false, version: "35.0.2" },
      info: { freeBytes: 812_000_000_000, users: 1, files: 4_812, activeUsers24h: 1, databaseBytes: 41_000_000 },
      quota: { usedBytes: 118_400_000_000, totalBytes: null, percent: null },
      recent: [
        file(901, "/Schule/Mathe/Analysis Übungsblatt 4.pdf", 482_113, 2, "application/pdf"),
        file(900, "/LifeOS-Uploads/Tafelbild Bio.jpg", 2_413_002, 5, "image/jpeg"),
        file(887, "/MusicProduction/Beat 12.flp", 9_120_441, 27, "application/octet-stream"),
        file(860, "/Schule/Deutsch/Erörterung Entwurf.docx", 41_920, 50, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      ],
    };
  },
};
