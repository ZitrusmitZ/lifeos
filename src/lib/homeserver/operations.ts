import "server-only";
import { z } from "zod";
import { invalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { piholeClient } from "./clients";
import { domainKindSchema, domainTypeSchema } from "./pihole";

/**
 * Schreibende Pi-hole-Operationen – gemeinsam für Server Actions (Oberfläche) und `/api/jobs/homeserver` (Agent).
 * Jede Operation prüft ihre Eingabe, leert danach den Pi-hole-Cache und liefert eine kurze deutsche Rückmeldung.
 */

export const pauseSchema = z.object({
  /** 1–1440 Minuten; `null` = bis zum Wiedereinschalten */
  minutes: z.number().int().min(1).max(1440).nullable(),
});

export const domainOpSchema = z.object({
  op: z.enum(["add", "remove"]),
  type: domainTypeSchema,
  kind: domainKindSchema.default("exact"),
  domain: z.string().max(255),
  comment: z.string().trim().max(200).optional(),
});

export type DomainOp = z.input<typeof domainOpSchema>;

function client() {
  const c = piholeClient();
  if (!c) throw new Error("Pi-hole ist nicht eingerichtet");
  return c;
}

const done = (message: string) => {
  invalidate(db(), "pihole:");
  return message;
};

export async function pausePihole(minutes: number | null): Promise<string> {
  const p = pauseSchema.parse({ minutes });
  await client().setBlocking(false, p.minutes === null ? undefined : p.minutes * 60);
  return done(p.minutes === null ? "Blocking aus – bis du es wieder einschaltest" : `Blocking für ${p.minutes} min pausiert`);
}

export async function resumePihole(): Promise<string> {
  await client().setBlocking(true);
  return done("Blocking ist wieder an");
}

export async function changeDomain(input: DomainOp): Promise<string> {
  const d = domainOpSchema.parse(input);
  if (d.op === "remove") {
    await client().removeDomain(d.type, d.kind, d.domain);
    return done(`${d.domain.trim()} entfernt`);
  }
  const [added] = await client().addDomain(d.type, d.kind, d.domain, d.comment);
  return done(`${added?.domain ?? d.domain.trim()} ${d.type === "allow" ? "freigegeben" : "gesperrt"}`);
}

export async function updateGravity(): Promise<string> {
  return done(`Blocklisten aktualisiert · ${await client().updateGravity()}`);
}

/** Fehler als kurze Meldung für Oberfläche und Agent. */
export function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? "Ungültige Eingabe";
  return err instanceof Error ? err.message : "Unbekannter Fehler";
}
