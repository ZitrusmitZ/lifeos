"use client";

import { Pause, Play, RefreshCw, Trash2, Upload } from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";
import type { FormState } from "@/app/actions";
import {
  nextcloudUploadAction,
  piholeAddDomainAction,
  piholeGravityAction,
  piholePauseAction,
  piholeRemoveDomainAction,
  piholeResumeAction,
} from "@/app/homeserver-actions";
import type { DomainKind, DomainType, PiholeDomain } from "@/lib/homeserver/pihole";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { Segmented } from "./ios/segmented";
import { SwipeRow } from "./ios/swipe-row";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

function Status({ state }: { state: FormState }) {
  if (!state) return null;
  return (
    <p role="status" className={cn("text-subhead", state.ok ? "text-muted-foreground" : "text-critical")}>
      {state.message}
    </p>
  );
}

/** Pausieren (5/30 min oder bis zum Einschalten) bzw. wieder einschalten. Dauerhaft aus nur nach Rückfrage. */
export function PiholeBlockingControls({ enabled, timer, compact = false }: { enabled: boolean; timer: number | null; compact?: boolean }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<FormState>(null);
  const run = (fn: () => Promise<FormState>) =>
    start(async () => {
      haptic();
      setState(await fn());
    });

  return (
    <div className="space-y-2">
      {enabled ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size={compact ? "sm" : "default"} disabled={pending} onClick={() => run(() => piholePauseAction(5))}>
            <Pause aria-hidden /> 5 min
          </Button>
          <Button variant="outline" size={compact ? "sm" : "default"} disabled={pending} onClick={() => run(() => piholePauseAction(30))}>
            30 min
          </Button>
          {compact ? null : (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (confirm("Werbeblocker ausschalten, bis du ihn wieder einschaltest?")) run(() => piholePauseAction(null));
              }}
            >
              Bis ich einschalte
            </Button>
          )}
        </div>
      ) : (
        <Button size={compact ? "sm" : "default"} disabled={pending} onClick={() => run(piholeResumeAction)}>
          <Play aria-hidden /> Blocking einschalten
        </Button>
      )}
      {!enabled && timer ? <p className="text-footnote text-muted-foreground">Schaltet sich in {Math.ceil(timer / 60)} min automatisch wieder ein.</p> : null}
      <Status state={state} />
    </div>
  );
}

const TYPE_OPTIONS: { value: DomainType; label: string }[] = [
  { value: "deny", label: "Sperren" },
  { value: "allow", label: "Freigeben" },
];
const KIND_OPTIONS: { value: DomainKind; label: string }[] = [
  { value: "exact", label: "Domain" },
  { value: "regex", label: "Regex" },
];

export function PiholeDomainForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(piholeAddDomainAction, null);
  const [type, setType] = useState<DomainType>("deny");
  const [kind, setKind] = useState<DomainKind>("exact");
  const form = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={form}
      action={async (fd) => {
        await action(fd);
        form.current?.reset();
      }}
      className="space-y-3"
    >
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="kind" value={kind} />
      <div className="grid grid-cols-2 gap-2">
        <Segmented label="Liste" value={type} options={TYPE_OPTIONS} onChange={setType} />
        <Segmented label="Art" value={kind} options={KIND_OPTIONS} onChange={setKind} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pihole-domain">{kind === "exact" ? "Domain" : "Regulärer Ausdruck"}</Label>
        <Input
          id="pihole-domain"
          name="domain"
          required
          maxLength={255}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode={kind === "exact" ? "url" : "text"}
          placeholder={kind === "exact" ? "ads.example.com" : "(\\.|^)tracker\\.example\\.com$"}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pihole-comment">Notiz (optional)</Label>
        <Input id="pihole-comment" name="comment" maxLength={200} placeholder="Warum?" />
      </div>
      <Button type="submit" disabled={pending}>
        {type === "deny" ? "Sperren" : "Freigeben"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function PiholeDomainList({ domains }: { domains: PiholeDomain[] }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<FormState>(null);
  if (!domains.length) return <p className="text-subhead text-muted-foreground">Noch keine eigenen Einträge.</p>;
  const remove = (d: PiholeDomain) => {
    if (!confirm(`„${d.domain}“ aus der ${d.type === "allow" ? "Freigabe" : "Sperr"}liste entfernen?`)) return;
    start(async () => setState(await piholeRemoveDomainAction(d.type, d.kind, d.domain)));
  };
  return (
    <div className="space-y-2">
      <ul className="ios-rows">
        {domains.map((d) => (
          <li key={`${d.type}-${d.kind}-${d.id}`}>
            <SwipeRow trailing={[{ label: "Entfernen", icon: Trash2, tone: "bg-critical", onAction: () => remove(d) }]}>
              <div className={cn("flex min-h-11 items-center gap-3 py-2", !d.enabled && "opacity-60")}>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-caption2 font-semibold",
                    d.type === "deny" ? "bg-critical/12 text-critical" : "bg-good/12 text-good",
                  )}
                >
                  {d.type === "deny" ? "gesperrt" : "frei"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-subhead", d.kind === "regex" && "font-mono text-footnote")}>{d.domain}</p>
                  {d.comment ? <p className="truncate text-footnote text-muted-foreground">{d.comment}</p> : null}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(d)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted active:opacity-60"
                  aria-label={`${d.domain} entfernen`}
                >
                  <Trash2 className="size-[1.125rem]" aria-hidden />
                </button>
              </div>
            </SwipeRow>
          </li>
        ))}
      </ul>
      <Status state={state} />
    </div>
  );
}

export function PiholeGravityButton() {
  const [pending, start] = useTransition();
  const [state, setState] = useState<FormState>(null);
  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={pending} onClick={() => start(async () => setState(await piholeGravityAction()))}>
        <RefreshCw className={cn(pending && "animate-spin")} aria-hidden />
        {pending ? "Lädt Blocklisten … (dauert etwas)" : "Blocklisten aktualisieren"}
      </Button>
      <Status state={state} />
    </div>
  );
}

export function NextcloudUploadForm({ defaultFolder }: { defaultFolder: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(nextcloudUploadAction, null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={form}
      action={async (fd) => {
        await action(fd);
        form.current?.reset();
      }}
      className="space-y-3"
    >
      <div className="space-y-1.5">
        <Label htmlFor="nc-files">Dateien (max. 10 MB je Datei)</Label>
        <Input id="nc-files" name="files" type="file" multiple required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nc-folder">Ordner in Nextcloud</Label>
        <Input id="nc-folder" name="folder" defaultValue={defaultFolder} maxLength={300} autoCapitalize="none" />
      </div>
      <Button type="submit" disabled={pending}>
        <Upload aria-hidden /> {pending ? "Lädt hoch …" : "Hochladen"}
      </Button>
      <Status state={state} />
    </form>
  );
}
