import "server-only";
import { env } from "@/lib/env";
import { createNextcloudClient, type NextcloudClient } from "./nextcloud";
import { createPiholeClient, type PiholeClient } from "./pihole";

/**
 * Ein Client pro Prozess: Pi-hole erlaubt nur wenige gleichzeitige Sessions, deshalb wird die Session-ID
 * über alle Anfragen hinweg geteilt. `null`, solange die Zugangsdaten in der .env fehlen.
 */

let pihole: PiholeClient | undefined;
let nextcloud: NextcloudClient | undefined;

export function piholeConfigured(): boolean {
  const e = env();
  return Boolean(e.PIHOLE_URL && e.PIHOLE_APP_PASSWORD);
}

export function nextcloudConfigured(): boolean {
  const e = env();
  return Boolean(e.NEXTCLOUD_URL && e.NEXTCLOUD_USER && e.NEXTCLOUD_APP_PASSWORD);
}

export function piholeClient(): PiholeClient | null {
  if (!piholeConfigured()) return null;
  const e = env();
  pihole ??= createPiholeClient({ url: e.PIHOLE_URL as string, password: e.PIHOLE_APP_PASSWORD as string });
  return pihole;
}

export function nextcloudClient(): NextcloudClient | null {
  if (!nextcloudConfigured()) return null;
  const e = env();
  nextcloud ??= createNextcloudClient({
    url: e.NEXTCLOUD_URL as string,
    user: e.NEXTCLOUD_USER as string,
    appPassword: e.NEXTCLOUD_APP_PASSWORD as string,
    publicUrl: e.NEXTCLOUD_PUBLIC_URL,
  });
  return nextcloud;
}

/** Admin-Oberfläche von Pi-hole im Browser (über `tailscale serve`), sonst `null`. */
export function piholeAdminUrl(): string | null {
  const pub = env().PIHOLE_PUBLIC_URL;
  return pub ? `${pub.replace(/\/+$/, "")}/admin/` : null;
}

export function nextcloudPublicUrl(): string | null {
  return env().NEXTCLOUD_PUBLIC_URL?.replace(/\/+$/, "") ?? null;
}
