"use client";

import { Trash2 } from "lucide-react";
import { useActionState, useTransition } from "react";
import {
  addMailRuleAction,
  clearInboxAction,
  deleteMailRuleAction,
  saveBriefingSettingsAction,
  saveWeeklyReviewSettingsAction,
  saveReadingSettingsAction,
  saveMailProfileAction,
  saveNewCardsAction,
  saveProfileAction,
  type FormState,
} from "@/app/actions";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/mail/policy";
import type { Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";
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

const Field = ({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Input>) => (
  <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} name={id} {...props} />
  </div>
);

export function ProfileForm({ settings }: { settings: Settings }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveProfileAction, null);
  const p = settings.defaultPlace;
  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2">
          <Field id="displayName" label="Name für die Begrüßung" defaultValue={settings.displayName} maxLength={40} />
        </div>
        <div className="col-span-2">
          <Field id="placeName" label="Standard-Ort (Wetter)" defaultValue={p?.name ?? ""} placeholder="z. B. Wandlitz" />
        </div>
        <Field id="lat" label="Breitengrad" defaultValue={p?.lat ?? ""} inputMode="decimal" placeholder="52.72" />
        <Field id="lon" label="Längengrad" defaultValue={p?.lon ?? ""} inputMode="decimal" placeholder="13.44" />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-subhead font-medium">Tagesziele</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field id="steps" label="Schritte" defaultValue={settings.goals.steps} inputMode="numeric" />
          <Field id="sleep" label="Schlaf (h)" defaultValue={settings.goals.sleep} inputMode="decimal" />
          <Field id="workout" label="Training (min)" defaultValue={settings.goals.workout} inputMode="numeric" />
          <Field id="energy" label="Aktivkalorien" defaultValue={settings.goals.energy} inputMode="numeric" />
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Speichern
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

// `switch` macht daraus in Safari (iOS 18+) einen echten iOS-Schalter, sonst bleibt es eine Checkbox
const SWITCH = { switch: "" } as Record<string, string>;

export function BriefingForm({ briefing }: { briefing: Settings["briefing"] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveBriefingSettingsAction, null);
  return (
    <form action={action} className="space-y-4">
      <div className="ios-inset-rows -mx-4 border-y border-border [--inset:16px]">
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Als Mitteilung schicken</span>
          <input type="checkbox" name="enabled" defaultChecked={briefing.enabled} className="size-5 accent-tint" {...SWITCH} />
        </label>
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Uhrzeit</span>
          <Input type="time" name="time" defaultValue={briefing.time} required className="w-[8.5rem] tabular-nums" />
        </label>
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Auch am Wochenende</span>
          <input type="checkbox" name="weekends" defaultChecked={briefing.weekends} className="size-5 accent-tint" {...SWITCH} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Speichern
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function WeeklyReviewForm({ review }: { review: Settings["weeklyReview"] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveWeeklyReviewSettingsAction, null);
  return (
    <form action={action} className="space-y-4">
      <div className="ios-inset-rows -mx-4 border-y border-border [--inset:16px]">
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Sonntags als Mitteilung schicken</span>
          <input type="checkbox" name="enabled" defaultChecked={review.enabled} className="size-5 accent-tint" {...SWITCH} />
        </label>
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Uhrzeit</span>
          <Input type="time" name="time" defaultValue={review.time} required className="w-[8.5rem] tabular-nums" />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Speichern
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function NewCardsForm({ perDay }: { perDay: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveNewCardsAction, null);
  return (
    <form action={action} className="space-y-4">
      <div className="ios-inset-rows -mx-4 border-y border-border [--inset:16px]">
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Neue Karten pro Tag</span>
          <Input type="number" name="perDay" min={1} max={500} defaultValue={perDay} required inputMode="numeric" className="w-[6rem] text-right tabular-nums" />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Speichern
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function MailProfileForm({ profile }: { profile: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveMailProfileAction, null);
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor="mailProfile">Über mich &amp; meine Mail-Vorlieben (bekommt die KI bei jeder Sortierung)</Label>
      <textarea
        id="mailProfile"
        name="mailProfile"
        defaultValue={profile}
        rows={7}
        maxLength={4000}
        className="w-full rounded-lg border bg-transparent px-3 py-2 text-subhead outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Speichern
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

const ACTIONS = { keep: "Behalten", archive: "Archivieren", trash: "Löschen" } as const;

export function ClearInboxForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(clearInboxAction, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm("Alle Mails aller Konten aus dem Posteingang archivieren (auch markierte)? Nichts wird gelöscht.")) e.preventDefault();
      }}
      className="space-y-2"
    >
      <p className="text-muted-foreground">
        Archiviert alles im Posteingang aller Konten. Die Mails bleiben unter „Alle E-Mails“ und dem Label <span className="font-medium">LifeOS/Aufgeräumt</span>.
      </p>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Wird geleert …" : "Posteingang leeren"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function RuleForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(addMailRuleAction, null);
  const select = "h-8 rounded-lg border bg-transparent px-2 text-subhead";
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="pattern">Absender oder Domain</Label>
        <Input id="pattern" name="pattern" placeholder="newsletter@shop.de oder shop.de" required />
      </div>
      <select name="action" aria-label="Aktion" className={select} defaultValue="trash">
        {Object.entries(ACTIONS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <select name="category" aria-label="Kategorie" className={select} defaultValue="">
        <option value="">Kategorie (optional)</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABEL[c]}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={pending}>
        Regel hinzufügen
      </Button>
      <div className="w-full">
        <Status state={state} />
      </div>
    </form>
  );
}

export function RuleList({
  rules,
}: {
  rules: { id: number; pattern: string; action: keyof typeof ACTIONS; category: keyof typeof CATEGORY_LABEL | null; source: string }[];
}) {
  const [pending, start] = useTransition();
  if (!rules.length) return <p className="text-subhead text-muted-foreground">Noch keine Regeln. Sie entstehen auch automatisch, wenn du im Mail-Assistenten entscheidest oder etwas rückgängig machst.</p>;
  return (
    <ul className={cn("divide-y text-subhead", pending && "opacity-60")}>
      {rules.map((r) => (
        <li key={r.id} className="flex items-center gap-2 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-footnote">{r.pattern}</span>
          <span className="shrink-0 text-footnote">{ACTIONS[r.action]}</span>
          <span className="hidden shrink-0 text-footnote text-muted-foreground sm:inline">
            {r.category ? CATEGORY_LABEL[r.category] : ""} · {r.source}
          </span>
          <button
            type="button"
            onClick={() => start(() => deleteMailRuleAction(r.id))}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Regel ${r.pattern} löschen`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ReadingForm({ reading }: { reading: Settings["reading"] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveReadingSettingsAction, null);
  return (
    <form action={action} className="space-y-4">
      <div className="ios-inset-rows -mx-4 border-y border-border [--inset:16px]">
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Tagesziel (Minuten)</span>
          <Input type="number" name="goalMinutes" min={1} max={600} defaultValue={reading.goalMinutes} required inputMode="numeric" className="w-[6rem] text-right tabular-nums" />
        </label>
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Erinnern, wenn das Ziel noch offen ist</span>
          <input type="checkbox" name="reminder" defaultChecked={reading.reminder} className="size-5 accent-tint" {...SWITCH} />
        </label>
        <label className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="flex-1 text-body">Uhrzeit</span>
          <Input type="time" name="time" defaultValue={reading.time} required className="w-[8.5rem] tabular-nums" />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Speichern
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}
