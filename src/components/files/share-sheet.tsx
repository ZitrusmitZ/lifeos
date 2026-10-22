"use client";

import { Check, Copy, Link2, Lock, Share2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes, SHARE_EXPIRY, SHARE_EXPIRY_LABEL, type FileEntry, type ShareExpiry, type ShareInfo } from "@/lib/files/types";
import { haptic } from "@/lib/haptics";
import { relativeTime } from "@/lib/time";
import { Segmented } from "../ios/segmented";
import { Sheet } from "../ios/sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function expiryLabel(s: Pick<ShareInfo, "expiresAt" | "state">): string {
  if (s.state === "widerrufen") return "widerrufen";
  if (s.state === "abgelaufen") return "abgelaufen";
  if (s.expiresAt === null) return "läuft nicht ab";
  const days = Math.ceil((s.expiresAt - Date.now()) / 86_400_000);
  return days <= 1 ? "läuft heute/morgen ab" : `noch ${days} Tage`;
}

/** Link kopieren; auf dem Handy lieber das System-Teilen-Menü. */
export async function copyLink(url: string, name: string, preferShare: boolean): Promise<string> {
  haptic();
  if (preferShare && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: name, url });
      return "Geteilt";
    } catch (err) {
      if ((err as Error).name === "AbortError") return "";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "Link kopiert";
  } catch {
    window.prompt("Link kopieren:", url);
    return "";
  }
}

export function LinkRow({ share, onRevoke, onToast }: { share: ShareInfo; onRevoke?: () => void; onToast: (m: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-h-12 items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-footnote">{share.url.replace(/^https?:\/\//, "")}</p>
        <p className="text-footnote text-muted-foreground">
          {expiryLabel(share)} · {share.downloads === 1 ? "1 Download" : `${share.downloads} Downloads`}
          {share.hasPassword ? " · mit Passwort" : ""}
        </p>
      </div>
      <button
        type="button"
        onClick={async () => {
          const m = await copyLink(share.url, share.name, false);
          if (m) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            onToast(m);
          }
        }}
        className="grid size-11 shrink-0 place-items-center rounded-full text-tint-text hover:bg-muted active:opacity-60"
        aria-label="Link kopieren"
      >
        {copied ? <Check className="size-5" aria-hidden /> : <Copy className="size-5" aria-hidden />}
      </button>
      {onRevoke ? (
        <button
          type="button"
          onClick={onRevoke}
          className="grid size-11 shrink-0 place-items-center rounded-full text-critical hover:bg-muted active:opacity-60"
          aria-label="Link widerrufen"
        >
          <Trash2 className="size-5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export async function revokeShare(token: string): Promise<string> {
  const res = await fetch(`/api/files/shares/${token}`, { method: "DELETE" });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? "Widerrufen fehlgeschlagen");
  return body.message ?? "Link widerrufen";
}

/**
 * Teilen wie bei MediaFire: Ablauf wählen, optional Passwort, ein Tipp → Link in der Zwischenablage bzw. im Teilen-Menü.
 * Vorhandene aktive Links auf die Datei stehen oben und lassen sich kopieren oder widerrufen.
 */
export function ShareSheet({ entry, onClose, onToast }: { entry: FileEntry | null; onClose: () => void; onToast: (m: string) => void }) {
  return (
    <Sheet open={entry !== null} onOpenChange={(o) => !o && onClose()} title="Teilen">
      {entry ? <ShareBody key={entry.path} entry={entry} onToast={onToast} /> : null}
    </Sheet>
  );
}

function ShareBody({ entry, onToast }: { entry: FileEntry; onToast: (m: string) => void }) {
  const [expiry, setExpiry] = useState<ShareExpiry>("7d");
  const [password, setPassword] = useState("");
  const [existing, setExisting] = useState<ShareInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = entry.path;

  useEffect(() => {
    let alive = true;
    fetch(`/api/files/shares?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((b: { shares?: ShareInfo[] }) => alive && setExisting(b.shares ?? []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/files/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: entry.path,
          expiry,
          password: password || undefined,
        }),
      });
      const body = (await res.json()) as ShareInfo & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Link konnte nicht erstellt werden");
      setExisting((e) => [body, ...e]);
      setPassword("");
      const m = await copyLink(body.url, body.name, window.matchMedia("(pointer: coarse)").matches);
      if (m) onToast(m);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (s: ShareInfo) => {
    if (!confirm("Link widerrufen? Wer ihn hat, kommt danach nicht mehr an die Datei.")) return;
    try {
      onToast(await revokeShare(s.token));
      setExisting((e) => e.filter((x) => x.token !== s.token));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-[16px] bg-card p-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-tint/12 text-tint-text">
          <Link2 className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold">{entry.name}</p>
          <p className="text-footnote text-muted-foreground">
            {formatBytes(entry.size)} · geändert {relativeTime(entry.modifiedAt)}
          </p>
        </div>
      </div>

      {existing.length ? (
        <div className="space-y-1">
          <h3 className="px-1 text-footnote font-semibold text-muted-foreground uppercase">Aktive Links</h3>
          <div className="ios-rows rounded-[16px] bg-card px-3">
            {existing.map((s) => (
              <LinkRow key={s.token} share={s} onRevoke={() => revoke(s)} onToast={onToast} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <h3 className="px-1 text-footnote font-semibold text-muted-foreground uppercase">{existing.length ? "Neuer Link" : "Link erstellen"}</h3>
        <Segmented
          label="Gültig für"
          value={expiry}
          onChange={setExpiry}
          options={SHARE_EXPIRY.map((v) => ({
            value: v,
            label: SHARE_EXPIRY_LABEL[v],
          }))}
        />
        <div className="space-y-1.5">
          <Label htmlFor="share-pw" className="flex items-center gap-1.5">
            <Lock className="size-3.5" aria-hidden /> Passwort (optional)
          </Label>
          <Input
            id="share-pw"
            type="password"
            autoComplete="new-password"
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Ohne Passwort kann jeder mit dem Link laden"
          />
        </div>
        <Button className="w-full" size="lg" disabled={busy} onClick={create}>
          <Share2 aria-hidden /> {busy ? "Erstelle Link …" : "Link erstellen & kopieren"}
        </Button>
        {error ? (
          <p role="alert" className="text-subhead text-critical">
            {error}
          </p>
        ) : null}
        <p className="px-1 text-footnote text-muted-foreground">
          Der Link führt auf eine eigene Download-Seite. Nur sie ist öffentlich – deine übrigen Dateien und LifeOS bleiben in deinem Tailnet.
        </p>
      </div>
    </div>
  );
}
