"use client";

import { History, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/components/agent-chat";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * Berechtigungen des Agenten: Modus (Standard / Auto / Nur lesen), Auto-Modus mit Countdown, Regeln (allow/ask/deny)
 * und das Log der automatisch genehmigten Aufrufe. Alles läuft über /api/agent/permissions (Tailscale-Login);
 * der Agent selbst kann den Modus nicht umschalten.
 */

export type Mode = "default" | "auto" | "readonly";
export type PState = { mode: Mode; baseMode: "default" | "readonly"; autoUntil: number | null; autoModeMinutes: number; now: number; fileError: string | null };
type Rules = { allow: string[]; ask: string[]; deny: string[] };
type Settings = { defaultMode: "default" | "readonly"; autoModeMinutes: number; permissions: Rules };
type PData = { state: PState; settings: Settings; builtin: { action: "deny" | "ask"; label: string }[] };
type LogEntry = { id: number; at: number; tool: string; command: string; rule: string; mode: string; decision: string };

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: "default", label: "Standard", hint: "Jeder Aufruf fragt per Klick" },
  { mode: "auto", label: "Auto", hint: "Aufrufe laufen ohne Klick – außer deny-/ask-Regeln" },
  { mode: "readonly", label: "Nur lesen", hint: "Nichts Änderndes" },
];
const MINUTES = [15, 30, 60, 120, 240];

export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Restzeit des Auto-Modus in ms, tickt jede Sekunde; `onExpire` einmal, wenn sie abläuft. Ohne Auto-Modus `null`. */
export function useRemaining(autoUntil: number | null | undefined, onExpire?: () => void): number | null {
  // erst im Effekt gesetzt: `Date.now()` im Initialzustand wäre beim Prerender ein eingefrorener Wert
  const [now, setNow] = useState<number | null>(null);
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });
  useEffect(() => {
    if (!autoUntil) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= autoUntil) {
        clearInterval(t);
        expire.current?.();
      }
    }, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [autoUntil]);
  return autoUntil && now !== null ? autoUntil - now : null;
}

/** Deutlicher Rand um den ganzen Bildschirm, solange der Auto-Modus läuft */
export function AutoModeFrame() {
  return <div aria-hidden className="pointer-events-none fixed inset-0 z-[60] border-4 border-warning" />;
}

const api = {
  get: () => call<PData>("GET", "/api/agent/permissions"),
  save: (s: Settings) => call<PData>("PUT", "/api/agent/permissions", s),
  mode: (mode: Mode, minutes?: number) => call<{ state: PState }>("POST", "/api/agent/permissions/mode", { mode, minutes }),
  extend: (minutes?: number) => call<{ state: PState }>("POST", "/api/agent/permissions/extend", { minutes }),
  log: (q: string, before?: number) => call<{ entries: LogEntry[] }>("GET", `/api/agent/permissions/log?${new URLSearchParams({ ...(q ? { q } : {}), ...(before ? { before: String(before) } : {}) })}`),
};

/** Modus-Schalter mit Countdown; `onState` meldet jede neue Zustandsfassung nach oben */
export function AutoModeBar({ compact = false, onState }: { compact?: boolean; onState?: (s: PState) => void }) {
  const [state, setState] = useState<PState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useRef<() => void>(() => undefined);
  const remaining = useRemaining(state?.autoUntil, () => reload.current());

  // Uhr des Servers und des Browsers können abweichen: Ablaufzeit auf die lokale Uhr umrechnen
  const apply = useCallback(
    (s: PState) => {
      const local = { ...s, autoUntil: s.autoUntil === null ? null : s.autoUntil - s.now + Date.now() };
      setState(local);
      onState?.(local);
    },
    [onState],
  );

  useEffect(() => {
    let stop = false;
    const load = () =>
      void api.get().then((res) => {
        if (stop) return;
        if (res.ok) {
          setError(null);
          apply(res.state);
        } else setError(res.error);
      });
    reload.current = load;
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [apply]);

  const run = async (f: () => Promise<{ ok: true; state: PState } | { ok: false; error: string }>) => {
    haptic();
    setBusy(true);
    const res = await f();
    setBusy(false);
    setConfirming(false);
    if (res.ok) {
      setError(null);
      apply(res.state);
    } else setError(res.error);
  };

  const auto = state?.mode === "auto";
  const chosen = minutes ?? state?.autoModeMinutes ?? 60;
  return (
    <section
      aria-label="Berechtigungsmodus"
      className={cn("flex flex-col gap-2 rounded-[20px] bg-card p-3", auto && "ring-2 ring-warning ring-inset")}
    >
      {auto ? <AutoModeFrame /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {auto ? <ShieldAlert className="size-5 shrink-0 text-warning" aria-hidden /> : state?.mode === "readonly" ? <ShieldOff className="size-5 shrink-0 text-muted-foreground" aria-hidden /> : <ShieldCheck className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold">
            {auto ? "Auto-Modus aktiv" : state?.mode === "readonly" ? "Nur lesen" : "Standard – jeder Aufruf fragt"}
          </p>
          {auto && remaining !== null ? (
            <p className="text-footnote text-muted-foreground tabular-nums" role="timer">
              noch {formatRemaining(remaining)} · eingebaute und eigene deny-/ask-Regeln gelten weiter
            </p>
          ) : null}
        </div>
        {auto ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.extend(state?.autoModeMinutes))}>
            +{state?.autoModeMinutes ?? 60} Min
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Modus wählen">
        {MODES.map((m) => (
          <Button
            key={m.mode}
            size="sm"
            variant={state?.mode === m.mode ? "default" : "outline"}
            disabled={busy || !state}
            aria-pressed={state?.mode === m.mode}
            title={m.hint}
            onClick={() => (m.mode === "auto" ? setConfirming(true) : void run(() => api.mode(m.mode)))}
          >
            {m.label}
          </Button>
        ))}
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-footnote">
          <span className="min-w-0 flex-1">Auto-Modus: Der Agent führt Befehle ohne Klick aus (auch als root), außer deny-/ask-Treffer.</span>
          <label className="flex items-center gap-1">
            für
            <select value={chosen} onChange={(e) => setMinutes(Number(e.target.value))} className="rounded-md bg-muted px-1.5 py-1 text-foreground">
              {[...new Set([...MINUTES, chosen])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {n} Min
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" disabled={busy} onClick={() => void run(() => api.mode("auto", chosen))}>
            Einschalten
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Abbrechen
          </Button>
        </div>
      ) : null}
      {state?.fileError ? <p className="text-footnote text-destructive">Regeldatei ungültig ({state.fileError}) – die letzte gültige Fassung gilt.</p> : null}
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      {!compact ? (
        <Link href="/agent/berechtigungen" className="flex min-h-9 items-center gap-1.5 text-footnote text-tint-text active:opacity-60">
          <History className="size-4" aria-hidden />
          Regeln und Log
        </Link>
      ) : null}
    </section>
  );
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function RulesEditor({ data, onSaved }: { data: PData; onSaved: (d: PData) => void }) {
  const [text, setText] = useState(() => ({
    allow: data.settings.permissions.allow.join("\n"),
    ask: data.settings.permissions.ask.join("\n"),
    deny: data.settings.permissions.deny.join("\n"),
  }));
  const [defaultMode, setDefaultMode] = useState(data.settings.defaultMode);
  const [minutes, setMinutes] = useState(String(data.settings.autoModeMinutes));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    haptic();
    const res = await api.save({
      defaultMode,
      autoModeMinutes: Number(minutes),
      permissions: { allow: lines(text.allow), ask: lines(text.ask), deny: lines(text.deny) },
    });
    if (res.ok) {
      setMsg({ ok: true, text: "Gespeichert" });
      onSaved(res);
    } else setMsg({ ok: false, text: res.error });
  };

  const field = (key: keyof Rules, title: string, hint: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-subhead font-semibold">{title}</span>
      <span className="text-footnote text-muted-foreground">{hint}</span>
      <textarea
        value={text[key]}
        onChange={(e) => setText({ ...text, [key]: e.target.value })}
        rows={4}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={key === "allow" ? "Bash(npm run *)\nroot_command(systemctl status *)" : ""}
        className="rounded-xl bg-muted p-3 font-mono text-footnote text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-4 rounded-[20px] bg-card p-4">
      <p className="text-footnote text-muted-foreground">
        Eine Regel pro Zeile: <code>Tool</code> oder <code>Tool(Muster)</code>, <code>*</code> ist Platzhalter (z. B. <code>root_command</code>, <code>Bash(npm run *)</code>, <code>mcp__server__*</code>). Priorität: deny vor ask vor allow.
        Dahinter liegen eingebaute Regeln, die sich hier nicht abschalten lassen. Gespeichert wird in <code>permissions.json</code> im Agent-Datenordner.
      </p>
      {field("deny", "deny – blockieren", "Wird nie ausgeführt, in keinem Modus.")}
      {field("ask", "ask – immer nachfragen", "Per Klick, auch im Auto-Modus.")}
      {field("allow", "allow – ohne Klick", "Gilt im Standard-Modus; bei zusammengesetzten Befehlen muss jeder Teil passen.")}
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-footnote">
          Modus nach dem Start
          <select value={defaultMode} onChange={(e) => setDefaultMode(e.target.value as "default" | "readonly")} className="min-h-9 rounded-md bg-muted px-2 text-body">
            <option value="default">Standard</option>
            <option value="readonly">Nur lesen</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-footnote">
          Auto-Modus schaltet sich ab nach (Min)
          <input type="number" min={1} max={480} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="min-h-9 w-28 rounded-md bg-muted px-2 text-body" />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()}>Speichern</Button>
        {msg ? (
          <p role="status" className={cn("text-footnote", msg.ok ? "text-muted-foreground" : "text-destructive")}>
            {msg.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const DECISION: Record<string, string> = { auto: "Auto", allow: "allow-Regel", deny: "blockiert", mode: "Modus" };

function LogView() {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const t = setTimeout(async () => {
      const res = await api.log(q.trim());
      if (stop) return;
      if (!res.ok) return setError(res.error);
      setError(null);
      setEntries(res.entries);
      setMore(res.entries.length >= 50);
    }, 250);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [q]);

  const loadMore = async () => {
    const last = entries[entries.length - 1];
    const res = await api.log(q.trim(), last?.id);
    if (!res.ok) return setError(res.error);
    setEntries((prev) => [...prev, ...res.entries]);
    setMore(res.entries.length >= 50);
  };

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Log durchsuchen (Befehl, Tool, Regel)"
        aria-label="Log durchsuchen"
        className="min-h-11 rounded-[10px] bg-muted px-3 text-body outline-none placeholder:text-muted-foreground"
      />
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      {!entries.length && !error ? <p className="py-4 text-center text-subhead text-muted-foreground">Keine Einträge.</p> : null}
      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.id} className="rounded-xl bg-card p-3">
            <div className="flex flex-wrap items-center gap-x-2 text-footnote text-muted-foreground tabular-nums">
              <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" })}</time>
              <span className={cn("rounded-full px-2 py-0.5 font-medium", e.decision === "deny" ? "bg-destructive/10 text-destructive" : e.decision === "mode" ? "bg-muted" : "bg-warning/15 text-foreground")}>
                {DECISION[e.decision] ?? e.decision}
              </span>
              <span className="font-semibold text-foreground">{e.tool}</span>
            </div>
            <pre className="mt-1 break-words whitespace-pre-wrap font-mono text-footnote">{e.command}</pre>
            <p className="text-caption2 text-muted-foreground">Regel: {e.rule}</p>
          </li>
        ))}
      </ul>
      {more ? (
        <Button variant="outline" className="self-center" onClick={() => void loadMore()}>
          Mehr laden
        </Button>
      ) : null}
    </div>
  );
}

export function PermissionsPanel() {
  const [data, setData] = useState<PData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void api.get().then((res) => {
      if (stop) return;
      if (res.ok) setData(res);
      else setError(res.error);
    });
    return () => {
      stop = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <AutoModeBar compact />
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      {data ? (
        <>
          <section className="flex flex-col gap-2" aria-label="Regeln">
            <h2 className="px-4 text-footnote font-semibold text-muted-foreground uppercase">Regeln</h2>
            <RulesEditor data={data} onSaved={setData} />
          </section>
          <section className="flex flex-col gap-2" aria-label="Eingebaute Regeln">
            <h2 className="px-4 text-footnote font-semibold text-muted-foreground uppercase">Eingebaut (gelten in jedem Modus)</h2>
            <ul className="overflow-hidden rounded-[20px] bg-card ios-inset-rows">
              {data.builtin.map((b) => (
                <li key={b.label} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={cn("w-14 shrink-0 rounded-full px-2 py-0.5 text-center text-caption2 font-semibold", b.action === "deny" ? "bg-destructive/10 text-destructive" : "bg-warning/15")}>
                    {b.action}
                  </span>
                  <span className="min-w-0 flex-1 text-subhead">{b.label}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
      <section className="flex flex-col gap-2" aria-label="Log">
        <h2 className="px-4 text-footnote font-semibold text-muted-foreground uppercase">Log – automatisch genehmigt oder blockiert</h2>
        <LogView />
      </section>
    </div>
  );
}
