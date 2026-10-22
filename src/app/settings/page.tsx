import type { Metadata } from "next";
import { CheckCircle2, ChevronRight, CircleAlert, CircleDashed } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { DisconnectButton } from "@/components/disconnect-button";
import { MailAppPicker } from "@/components/mail-link";
import { BriefingForm, ClearInboxForm, MailProfileForm, NewCardsForm, ProfileForm, RuleForm, RuleList, WeeklyReviewForm } from "@/components/settings-forms";
import { googleAccounts, missingFeatures } from "@/integrations/google";
import { db, plainRows } from "@/lib/db";
import { monthSpendUsd } from "@/lib/openai";
import { getSettings } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { WidgetSkeleton } from "@/components/widget-card";
import { github } from "@/integrations/github";
import { nextcloud } from "@/integrations/nextcloud";
import { pihole } from "@/integrations/pihole";
import { googleRedirectUri } from "@/integrations/google";
import { spotifyRedirectUri } from "@/integrations/spotify";
import { untis } from "@/integrations/untis";
import { env, isDemo } from "@/lib/env";
import { getToken } from "@/lib/tokens";

export const metadata: Metadata = { title: "Einstellungen" };

type State = "ok" | "todo" | "off";

function StatusLabel({ state, children }: { state: State; children: ReactNode }) {
  const Icon = state === "ok" ? CheckCircle2 : state === "todo" ? CircleAlert : CircleDashed;
  const color = state === "ok" ? "text-good" : state === "todo" ? "text-warning" : "text-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
      <Icon className={`size-4 ${color}`} aria-hidden />
      {children}
    </span>
  );
}

function Row({ id, title, description, state, status, children }: { id: string; title: string; description: string; state: State; status: string; children?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 rounded-[20px] bg-card p-4 desktop:scroll-mt-20">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-body font-semibold">{title}</h2>
          <p className="text-footnote text-muted-foreground">{description}</p>
        </div>
        {status ? <StatusLabel state={state}>{status}</StatusLabel> : null}
      </div>
      {children ? <div className="mt-3 space-y-2 text-subhead">{children}</div> : null}
    </section>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-footnote break-all">{children}</code>
);

const MESSAGES: Record<string, string> = {
  demo: "Im Demo-Modus sind echte Verbindungen deaktiviert.",
  "google-config": "GOOGLE_CLIENT_ID/SECRET fehlen in der .env.",
  "spotify-config": "SPOTIFY_CLIENT_ID fehlt in der .env.",
  "google-denied": "Google-Anmeldung abgebrochen oder abgelaufen.",
  "spotify-denied": "Spotify-Anmeldung abgebrochen oder abgelaufen.",
  "google-exchange": "Google-Token konnte nicht abgerufen werden (Logs prüfen).",
  "spotify-exchange": "Spotify-Token konnte nicht abgerufen werden (Logs prüfen).",
};

async function SettingsContent({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await connection();
  const params = await searchParams;
  const demo = isDemo();
  const e = env();
  const connectBtn = (provider: "google" | "spotify", label: string) => (
    <a href={`/api/auth/${provider}/start`} className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-body font-semibold text-primary-foreground active:opacity-70">
      {label}
    </a>
  );

  const providerState = (provider: "google" | "spotify", configured: boolean): [State, string] =>
    demo ? ["ok", "Demo"] : !configured ? ["off", "Nicht eingerichtet"] : getToken(provider) ? ["ok", "Verbunden"] : ["todo", "Nicht verbunden"];

  const accounts = demo ? [] : await googleAccounts();
  const googleConfigured = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
  const [gState, gStatus]: [State, string] = demo
    ? ["ok", "Demo"]
    : !googleConfigured
      ? ["off", "Nicht eingerichtet"]
      : accounts.length
        ? ["ok", `${accounts.length} ${accounts.length > 1 ? "Konten" : "Konto"} verbunden`]
        : ["todo", "Nicht verbunden"];
  const settings = getSettings(db());
  const rules = plainRows<Parameters<typeof RuleList>[0]["rules"][number]>(
    db().prepare("SELECT id, pattern, action, category, source FROM mail_rules ORDER BY id DESC").all(),
  );
  const [sState, sStatus] = providerState("spotify", Boolean(e.SPOTIFY_CLIENT_ID));
  const simple = (missing: unknown): [State, string] => (demo ? ["ok", "Demo"] : missing ? ["off", "Nicht eingerichtet"] : ["ok", "Aktiv"]);
  const [uState, uStatus] = simple(untis.missingConfig());
  const [ghState, ghStatus] = simple(github.missingConfig());
  const [phState, phStatus] = simple(pihole.missingConfig());
  const [ncState, ncStatus] = simple(nextcloud.missingConfig());
  const ingestUrl = `${e.APP_URL}/api/ingest/health`;

  return (
    <div className="space-y-4">
      <nav aria-label="Allgemein" className="ios-inset-rows rounded-[20px] bg-card">
        {[
          ["/settings/uebersicht", "Übersicht anpassen", "Widgets der Heute-Seite ordnen und ein-/ausblenden"],
          ["/briefing", "Morgenbriefing", "Heute ansehen: Wetter, Schule, Termine, Nachrichten"],
          ["/rueckblick", "Wochenrückblick", "Gewohnheiten, Lernzeit, Schlaf und Noten der Woche"],
          ["/noten", "Noten", "Halbjahresnoten, Ziele und Abi-Hochrechnung"],
          ["/habits", "Erinnerungen", "Mitteilungen für Gewohnheiten"],
          ["/server", "Server", "Pi-hole und Nextcloud: Status, Pausieren, Listen, Upload"],
        ].map(([href, label, hint]) => (
          <Link key={href} href={href} className="flex min-h-14 items-center gap-3 px-4 py-2 active:bg-muted">
            <span className="min-w-0 flex-1">
              <span className="block text-body">{label}</span>
              <span className="block text-footnote text-muted-foreground">{hint}</span>
            </span>
            <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
          </Link>
        ))}
      </nav>
      {params.connected ? (
        <p role="status" className="rounded-[14px] bg-good/12 px-4 py-3 text-subhead">
          {params.connected === "google" ? "Google" : "Spotify"} ist verbunden.
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="rounded-[14px] bg-critical/12 px-4 py-3 text-subhead">
          {MESSAGES[params.error] ?? "Unbekannter Fehler."}
        </p>
      ) : null}

      <Row id="profil" title="Persönlich" description="Begrüßung, Standard-Ort fürs Wetter und deine Tagesziele." state="ok" status="">
        <ProfileForm settings={settings} />
      </Row>

      <Row
        id="briefing"
        title="Morgenbriefing"
        description="Jeden Morgen eine Mitteilung mit Wetter, erster Stunde, Ausfällen, Klausuren und den wichtigsten Nachrichten (von der KI zusammengefasst, ca. 0,2 Cent pro Tag). Mitteilungen erlaubst du unter „Erinnerungen“."
        state={settings.briefing.enabled ? "ok" : "off"}
        status={settings.briefing.enabled ? `${settings.briefing.weekends ? "Täglich" : "Mo–Fr"} ${settings.briefing.time}` : "Aus"}
      >
        <BriefingForm briefing={settings.briefing} />
      </Row>

      <Row
        id="rueckblick"
        title="Wochenrückblick"
        description="Sonntags eine Mitteilung mit Gewohnheiten, Lernzeit (Plan gegen Ist), Karteikarten, Schlaf und Noten der Woche – mit kurzem KI-Kommentar (unter 0,1 Cent pro Woche)."
        state={settings.weeklyReview.enabled ? "ok" : "off"}
        status={settings.weeklyReview.enabled ? `So ${settings.weeklyReview.time}` : "Aus"}
      >
        <WeeklyReviewForm review={settings.weeklyReview} />
      </Row>

      <Row
        id="karteikarten"
        title="Karteikarten"
        description="Neue Karten kommen gestaffelt dazu, damit ein großer KI-Stapel nicht auf einmal fällig wird und sich die Wiederholungen der nächsten Tage nicht stauen. Quick Learn ist davon ausgenommen."
        state="ok"
        status={`${settings.newCardsPerDay} neue pro Tag`}
      >
        <NewCardsForm perDay={settings.newCardsPerDay} />
      </Row>

      <Row id="untis" title="Schule (WebUntis)" description="Stundenplan, Ausfälle und Vertretungen der nächsten 7 Tage." state={uState} status={uStatus}>
        {uState !== "ok" ? <p>In der <Code>.env</Code> eintragen: <Code>UNTIS_SERVER</Code>, <Code>UNTIS_SCHOOL</Code>, <Code>UNTIS_USER</Code>, <Code>UNTIS_PASSWORD</Code>.</p> : null}
      </Row>

      <Row id="google" title="Google (Kalender, Gmail, Drive)" description="Mehrere Konten möglich. Liest Kalender, Gmail und Drive; schreibt nur für neue Termine, den Mail-Assistenten (Labels, Archiv) und „Drive aufräumen“ – Mails und Dateien landen höchstens im Papierkorb, nie endgültig gelöscht." state={gState} status={gStatus}>
        {!demo && gState === "off" ? (
          <p>
            OAuth-Client (Typ „Webanwendung“) anlegen, Weiterleitungs-URI <Code>{googleRedirectUri()}</Code> eintragen, dann <Code>GOOGLE_CLIENT_ID</Code> und <Code>GOOGLE_CLIENT_SECRET</Code> in die <Code>.env</Code>. Anleitung: <Code>docs/SETUP.md</Code>.
          </p>
        ) : null}
        {accounts.length ? (
          <ul className="ios-rows rounded-[14px] bg-muted px-3">
            {accounts.map((a) => (
              <li key={a} className="flex min-h-11 flex-wrap items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-semibold">{a}</span>
                {missingFeatures(a).length ? (
                  <a href="/api/auth/google/start" className="text-footnote font-semibold text-serious">
                    Neu verbinden für {missingFeatures(a).join(", ")}
                  </a>
                ) : (
                  <span className="text-footnote text-muted-foreground">Alle Funktionen aktiv</span>
                )}
                <DisconnectButton provider={`google:${a}`} />
              </li>
            ))}
          </ul>
        ) : null}
        {accounts.length || demo ? (
          <div className="space-y-1.5">
            <h3 className="font-semibold">Mails öffnen in</h3>
            <MailAppPicker value={settings.mailApp} />
            <p className="text-footnote text-muted-foreground">
              Gilt auf iPhone und iPad. Apple Mail springt direkt zur Mail, wenn das Konto dort eingerichtet ist; die Gmail-App öffnet nur den Posteingang (Google bietet keinen Link auf einzelne Mails).
            </p>
          </div>
        ) : null}
        {accounts.length || demo ? (
          <Link href="/drive" className="flex min-h-11 items-center justify-between rounded-[14px] bg-muted px-3 font-semibold text-tint-text active:opacity-60">
            Drive aufräumen
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </Link>
        ) : null}
        {!demo && googleConfigured ? connectBtn("google", accounts.length ? "Weiteres Google-Konto verbinden" : "Mit Google verbinden") : null}
      </Row>

      <Row
        id="mail"
        title="Mail-Assistent"
        description="Sortiert zweimal täglich (06:00 & 16:00) alle verbundenen Postfächer: Labels, Archiv, Papierkorb (30 Tage wiederherstellbar). Unsicheres landet im Widget zur Entscheidung."
        state={demo ? "ok" : e.OPENAI_API_KEY ? "ok" : "todo"}
        status={demo ? "Demo" : e.OPENAI_API_KEY ? `KI aktiv · ${monthSpendUsd(db()).toFixed(2)} $ von ${e.OPENAI_MONTHLY_BUDGET_USD} $ diesen Monat` : "OPENAI_API_KEY fehlt"}
      >
        <MailProfileForm profile={settings.mailProfile} />
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="font-semibold">Absender-Regeln</h3>
          <p className="text-muted-foreground">Regeln gelten vor der KI. Sicherheits-Mails und markierte Mails werden nie angefasst.</p>
          <RuleForm />
          <RuleList rules={rules} />
        </div>
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="font-semibold">Posteingang leeren</h3>
          <ClearInboxForm />
        </div>
      </Row>

      <Row id="spotify" title="Spotify" description="Läuft gerade, zuletzt gehört, Top-Artists der letzten 4 Wochen." state={sState} status={sStatus}>
        {!demo && sState === "off" ? (
          <p>
            App im Spotify-Developer-Dashboard anlegen (benötigt Spotify Premium), Redirect-URI <Code>{spotifyRedirectUri()}</Code>, dann <Code>SPOTIFY_CLIENT_ID</Code> in die <Code>.env</Code>.
          </p>
        ) : null}
        {!demo && sState === "todo" ? connectBtn("spotify", "Mit Spotify verbinden") : null}
        {!demo && sState === "ok" ? <DisconnectButton provider="spotify" /> : null}
      </Row>

      <Row id="github" title="GitHub" description="Beiträge, zuletzt aktive Repos mit CI-Status und offene Pull Requests." state={ghState} status={ghStatus}>
        {ghState !== "ok" ? <p>Fine-grained Token (nur lesend) als <Code>GITHUB_TOKEN</Code> in die <Code>.env</Code>.</p> : null}
      </Row>

      <Row id="pihole" title="Pi-hole" description="Werbeblocker im Heimnetz: Statistik, Pausieren, eigene Freigaben und Sperren, Blocklisten aktualisieren." state={phState} status={phStatus}>
        {phState !== "ok" ? (
          <p>
            In Pi-hole unter Einstellungen → Web-Oberfläche/API ein App-Passwort erzeugen, dann <Code>PIHOLE_URL</Code> (im Docker-Netz <Code>http://pihole</Code>),{" "}
            <Code>PIHOLE_APP_PASSWORD</Code> und optional <Code>PIHOLE_PUBLIC_URL</Code> (Link zur Admin-Oberfläche) in die <Code>.env</Code>.
          </p>
        ) : null}
      </Row>

      <Row id="nextcloud" title="Nextcloud" description="Eigene Cloud auf dem Homeserver: Speicher, zuletzt geänderte Dateien und Upload aus LifeOS." state={ncState} status={ncStatus}>
        {ncState !== "ok" ? (
          <p>
            App-Passwort mit <Code>occ user:auth-tokens:add &lt;nutzer&gt;</Code> erzeugen, dann <Code>NEXTCLOUD_URL</Code> (im Docker-Netz <Code>http://nextcloud</Code>),{" "}
            <Code>NEXTCLOUD_USER</Code>, <Code>NEXTCLOUD_APP_PASSWORD</Code> und optional <Code>NEXTCLOUD_PUBLIC_URL</Code> in die <Code>.env</Code>.
          </p>
        ) : null}
      </Row>

      <Row
        id="health"
        title="iPhone-Kurzbefehl (Apple Health)"
        description="Eine tägliche Automation schickt Schritte, Schlaf, Training usw. an LifeOS."
        state={demo ? "ok" : e.INGEST_TOKEN ? "ok" : "off"}
        status={demo ? "Demo" : e.INGEST_TOKEN ? "Bereit" : "INGEST_TOKEN fehlt"}
      >
        <p>
          <span className="text-muted-foreground">Endpunkt:</span> <Code>POST {ingestUrl}</Code>
        </p>
        <p>
          <span className="text-muted-foreground">Header:</span> <Code>Authorization: Bearer &lt;INGEST_TOKEN&gt;</Code>
        </p>
        <p>
          <span className="text-muted-foreground">JSON:</span> <Code>{`{"steps": 8432, "sleep": 7.5, "workout": 45, "energy": 520, "heart": 58}`}</Code>
        </p>
        <p className="text-muted-foreground">Schritt-für-Schritt-Anleitung in <Code>docs/SETUP.md</Code>.</p>
      </Row>

      <Row id="weather" title="Wetter & Nachrichten" description="Open-Meteo am Gerätestandort (sonst Standard-Ort). Nachrichten: Tagesschau, Politik, rbb24 Region & Blaulicht, heise, The Verge, Hacker News – Meldungen aus deiner Umgebung werden hervorgehoben." state="ok" status="Aktiv" />
    </div>
  );
}

export default function SettingsPage(props: PageProps<"/settings">) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Einstellungen" back={{ href: "/", label: "Heute" }} />
      <Suspense fallback={<WidgetSkeleton lines={8} />}>
        <SettingsContent searchParams={props.searchParams as Promise<Record<string, string | undefined>>} />
      </Suspense>
    </div>
  );
}
