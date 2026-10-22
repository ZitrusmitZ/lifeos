"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { invalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { nextcloudClient } from "@/lib/homeserver/clients";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "@/lib/homeserver/nextcloud";
import { changeDomain, errorMessage, pausePihole, resumePihole, updateGravity } from "@/lib/homeserver/operations";
import type { FormState } from "./actions";

/** Server Actions für Pi-hole und Nextcloud (Server-Seite, Widgets). Eingaben prüft `@/lib/homeserver/operations`. */

const DEMO: FormState = { ok: false, message: "Im Demo-Modus deaktiviert" };

async function run(op: () => Promise<string>): Promise<FormState> {
  if (isDemo()) return DEMO;
  try {
    const message = await op();
    revalidatePath("/", "layout");
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Pausenlängen, die die Oberfläche anbietet; `null` = bis zum Wiedereinschalten. */
const pauseMinutes = z.union([z.literal(5), z.literal(30), z.literal(60), z.null()]);

export async function piholePauseAction(minutes: number | null): Promise<FormState> {
  return run(() => pausePihole(pauseMinutes.parse(minutes)));
}

export async function piholeResumeAction(): Promise<FormState> {
  return run(resumePihole);
}

export async function piholeAddDomainAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(() =>
    changeDomain({
      op: "add",
      type: String(formData.get("type")) as "allow" | "deny",
      kind: String(formData.get("kind") ?? "exact") as "exact" | "regex",
      domain: String(formData.get("domain") ?? ""),
      comment: String(formData.get("comment") ?? "") || undefined,
    }),
  );
}

export async function piholeRemoveDomainAction(type: string, kind: string, domain: string): Promise<FormState> {
  return run(() => changeDomain({ op: "remove", type: type as "allow" | "deny", kind: kind as "exact" | "regex", domain }));
}

export async function piholeGravityAction(): Promise<FormState> {
  return run(updateGravity);
}

const folderSchema = z.string().trim().max(300, "Ordnername zu lang");

export async function nextcloudUploadAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (isDemo()) return DEMO;
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const folder = folderSchema.safeParse(formData.get("folder") ?? "");
  if (!files.length) return { ok: false, message: "Bitte mindestens eine Datei auswählen" };
  if (!folder.success) return { ok: false, message: folder.error.issues[0].message };
  const client = nextcloudClient();
  if (!client) return { ok: false, message: "Nextcloud ist nicht eingerichtet" };
  const dir = folder.data || UPLOAD_DIR;
  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const f of files.slice(0, 10)) {
    if (f.size > MAX_UPLOAD_BYTES) {
      skipped.push(`${f.name} (über ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      continue;
    }
    try {
      await client.upload(dir, f.name, f, f.type);
      uploaded.push(f.name);
    } catch (err) {
      skipped.push(`${f.name} (${errorMessage(err)})`);
    }
  }
  if (uploaded.length) {
    invalidate(db(), "nextcloud:");
    revalidatePath("/", "layout");
  }
  const note = skipped.length ? ` · nicht hochgeladen: ${skipped.join(", ")}` : "";
  if (!uploaded.length) return { ok: false, message: `Nichts hochgeladen${note}` };
  return { ok: true, message: `${uploaded.length === 1 ? `„${uploaded[0]}“` : `${uploaded.length} Dateien`} nach /${dir} hochgeladen${note}` };
}
