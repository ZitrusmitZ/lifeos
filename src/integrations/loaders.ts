import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "@/lib/db";
import { env, isDemo } from "@/lib/env";
import { mailAssistantData, type MailAssistantData } from "@/lib/mail/triage";
import { getSettings } from "@/lib/settings";
import { dayEnd, listDecks, newCardsLeft } from "@/lib/flashcards";
import { listGradeCourses, projection } from "@/lib/grades";
import { listHabits } from "@/lib/habits";
import { healthSeries } from "@/lib/health";
import { lastDays, today } from "@/lib/time";
import { load } from "./core";
import { github } from "./github";
import { exams } from "./exams";
import { google } from "./google";
import { news } from "./news";
import { nextcloud } from "./nextcloud";
import { pihole } from "./pihole";
import { spotify } from "./spotify";
import { untis } from "./untis";
import { weather, type Coords } from "./weather";

// React `cache` dedupliziert pro Anfrage: mehrere Widgets teilen sich einen Abruf.
export const loadUntis = cache(() => load(untis, undefined));
export const loadGoogle = cache(() => load(google, undefined));
export const loadExams = cache(() => load(exams, undefined));
export const loadGitHub = cache(() => load(github, undefined));
export const loadSpotify = cache(() => load(spotify, undefined));
export const loadNews = cache(() => load(news, undefined));
export const loadPihole = cache(() => load(pihole, undefined));
export const loadNextcloud = cache(() => load(nextcloud, undefined));

export const LOCATION_COOKIE = "lifeos_loc";

export const loadWeather = cache(async () => {
  const raw = (await cookies()).get(LOCATION_COOKIE)?.value;
  const [lat, lon] = (raw ?? "").split(",").map(Number);
  const place = (await loadSettings()).defaultPlace;
  const fallback: Coords = place ? { lat: place.lat, lon: place.lon } : { lat: env().DEFAULT_LAT, lon: env().DEFAULT_LON };
  const coords: Coords = Number.isFinite(lat) && Number.isFinite(lon) && raw ? { lat, lon } : fallback;
  return { located: Boolean(raw), result: await load(weather, coords) };
});

export const currentDay = cache(async () => {
  await connection();
  return today(env().APP_TZ);
});

export const loadHabits = cache(async (historyDays: number = 7) => listHabits(db(), await currentDay(), historyDays));

export const loadHealth = cache(async (days: number) => {
  const range = lastDays(await currentDay(), days);
  return { days: range, series: healthSeries(db(), range) };
});

/** Jetzt, Ende des Tages und wie viele neue Karten heute noch dürfen – „fällig“ heißt: bis heute Abend dran. */
export const cardWindow = cache(async () => {
  await connection();
  const now = Date.now();
  const tz = env().APP_TZ;
  return { now, end: dayEnd(now, tz), newLeft: newCardsLeft(db(), now, tz, (await loadSettings()).newCardsPerDay) };
});

export const loadDecks = cache(async () => {
  const { now, end, newLeft } = await cardWindow();
  return listDecks(db(), now, end, newLeft);
});

export const loadGrades = cache(async () => {
  const { gradeSemester: semester } = await loadSettings();
  const courses = listGradeCourses(db());
  return { semester, courses, projection: projection(courses) };
});

export const loadSettings = cache(async () => {
  await connection();
  return getSettings(db());
});

/** null = kein Google-Konto verbunden */
export const loadMailAssistant = cache(async (): Promise<MailAssistantData | null> => {
  await connection();
  if (isDemo()) return mockMailAssistant();
  if (!env().GOOGLE_CLIENT_ID) return null;
  const data = await mailAssistantData(db());
  return data;
});

function mockMailAssistant(): MailAssistantData {
  const ago = (min: number) => Date.now() - min * 60_000;
  const acc = "luis@example.com";
  return {
    pending: [
      { account: acc, id: "p1", fromName: "Studienkreis", subject: "Kostenlose Probestunde für dein Abi", category: "werbung", action: "trash", reason: "Werbung, aber evtl. relevant fürs Abi", confidence: 0.55, processedAt: ago(30) },
      { account: acc, id: "p2", fromName: "Discord", subject: "Du hast 12 neue Nachrichten", category: "social", action: "archive", reason: "Benachrichtigung, unklar ob gelesen", confidence: 0.58, processedAt: ago(30) },
    ],
    recent: [
      { account: acc, id: "r1", fromName: "Zalando", subject: "Nur heute: -30 % auf alles", category: "werbung", action: "trash", reason: "Rabattaktion", confidence: 0.97, processedAt: ago(30) },
      { account: acc, id: "r2", fromName: "GitHub", subject: "[SpySpecter/lifeos] Dependabot alert", category: "benachrichtigung", action: "archive", reason: "Entwickler-Benachrichtigung", confidence: 0.92, processedAt: ago(30) },
      { account: acc, id: "r3", fromName: "Instagram", subject: "Neue Follower-Anfragen", category: "social", action: "trash", reason: "Social-Media-Benachrichtigung", confidence: 0.9, processedAt: ago(30) },
      { account: acc, id: "r4", fromName: "heise Newsletter", subject: "Die Woche bei heise", category: "newsletter", action: "archive", reason: "Newsletter, manchmal gelesen", confidence: 0.84, processedAt: ago(30) },
    ],
    today: { archived: 14, trashed: 23, kept: 6 },
    lastRun: { at: ago(30), summary: { accounts: 1, scanned: 45, kept: 6, archived: 14, trashed: 23, pending: 2, notes: [] }, error: null },
    needsReconnect: [],
    aiConfigured: true,
    monthUsd: 0.04,
    budgetUsd: 1,
  };
}
