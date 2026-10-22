import { addDays, localClock, zonedToEpoch } from "../../lib/time.ts";

/**
 * Minimaler 5-Felder-Cron (Minute Stunde Tag Monat Wochentag) mit Zeitzone.
 * Unterstützt `*`, Zahlen, Bereiche `a-b`, Listen `a,b`, Schritte `*∕n` und `a-b/n`; Wochentag 0–7 (0 und 7 = Sonntag).
 * Wie bei klassischem cron gilt: Sind Tag UND Wochentag eingeschränkt, reicht einer von beiden.
 */

export type CronSpec = {
  minutes: number[];
  hours: number[];
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
};

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field: string, [min, max]: [number, number]): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Ungültiges Cron-Feld „${field}“`);
    let [lo, hi] = [min, max];
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Cron-Feld „${field}“ außerhalb ${min}–${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron braucht 5 Felder: Minute Stunde Tag Monat Wochentag");
  const [mi, h, dom, mon, dow] = fields.map((f, i) => parseField(f, RANGES[i]));
  return {
    minutes: mi,
    hours: h,
    dom: new Set(dom),
    months: new Set(mon),
    dow: new Set(dow.map((d) => (d === 7 ? 0 : d))),
    domAny: fields[2] === "*",
    dowAny: fields[4] === "*",
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

function dayMatches(spec: CronSpec, day: string): boolean {
  const [, month, date] = day.split("-").map(Number);
  if (!spec.months.has(month)) return false;
  const domOk = spec.dom.has(date);
  const dowOk = spec.dow.has(weekday(day));
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dowOk;
  if (spec.dowAny) return domOk;
  return domOk || dowOk;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Nächster Zeitpunkt (ms) strikt nach `after` in der Zeitzone `tz`; Wanduhrzeiten, die es wegen Zeitumstellung nicht gibt, entfallen. */
export function nextRun(expr: string | CronSpec, after: number, tz: string): number | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const start = localClock(new Date(after), tz);
  const startHour = Number(start.hhmm.slice(0, 2));
  for (let i = 0; i <= 366 * 5; i++) {
    const day = addDays(start.day, i);
    if (!dayMatches(spec, day)) continue;
    for (const h of spec.hours) {
      // am ersten Tag frühere Stunden überspringen (eine Stunde Puffer wegen Zeitumstellung)
      if (i === 0 && h < startHour - 1) continue;
      for (const m of spec.minutes) {
        const hhmm = `${pad(h)}:${pad(m)}`;
        const t = zonedToEpoch(day, hhmm, tz);
        if (t <= after) continue;
        const check = localClock(new Date(t), tz);
        if (check.day === day && check.hhmm === hhmm) return t;
      }
    }
  }
  return null;
}

const DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const DAY_LONG = ["Sonntags", "Montags", "Dienstags", "Mittwochs", "Donnerstags", "Freitags", "Samstags"];

function describeDays(spec: CronSpec): string {
  const dom = spec.domAny ? "" : `am ${[...spec.dom].join(".,")}. `;
  if (spec.dowAny) return spec.domAny ? "täglich" : `${dom}des Monats`.trim();
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => spec.dow.has(d));
  const key = days.join(",");
  let text: string;
  if (key === "1,2,3,4,5") text = "werktags (Mo–Fr)";
  else if (key === "6,0") text = "am Wochenende";
  else if (days.length === 7) text = "täglich";
  else if (days.length === 1) text = DAY_LONG[days[0]];
  else {
    // zusammenhängende Folge als Bereich, z. B. Mo–Do
    const contiguous = days.every((d, i) => i === 0 || ((days[i - 1] % 7) + 1) % 7 === d);
    text = contiguous && days.length > 2 ? `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}` : days.map((d) => DAY_NAMES[d]).join(", ");
  }
  return dom ? `${dom}oder ${text}` : text;
}

function stepOf(values: number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1] - values[0];
  const expected = Math.floor((max - min) / step) + 1;
  return values.every((v, i) => v === min + i * step) && values.length === expected ? step : null;
}

/** Menschenlesbar, z. B. `0 16 * * 5` → „Freitags 16:00“. */
export function describeCron(expr: string): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return expr;
  }
  const days = describeDays(spec);
  const minuteStep = stepOf(spec.minutes, 0, 59);
  if (spec.hours.length === 24 && minuteStep && minuteStep > 1) return `alle ${minuteStep} Minuten${days === "täglich" ? "" : `, ${days}`}`;
  const hourStep = stepOf(spec.hours, 0, 23);
  if (spec.minutes.length === 1 && hourStep && spec.hours.length > 1) {
    return `${hourStep === 1 ? "stündlich" : `alle ${hourStep} Stunden`} zur Minute ${spec.minutes[0]}${days === "täglich" ? "" : `, ${days}`}`;
  }
  if (spec.hours.length * spec.minutes.length <= 4) {
    const times = spec.hours.flatMap((h) => spec.minutes.map((m) => `${pad(h)}:${pad(m)}`)).join(", ");
    return `${days.charAt(0).toUpperCase()}${days.slice(1)} ${times}`;
  }
  return `${expr} (${days})`;
}
