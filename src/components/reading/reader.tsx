"use client";

import { AArrowDown, AArrowUp, ChevronLeft, ChevronRight, List, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chapter, TocItem } from "@/lib/epub";
import { cn } from "@/lib/utils";
import { fileUrl } from "./library";

/**
 * Vollbild-Leser: ein Kapitel pro iframe (fremdes HTML, ohne Scripts, siehe /api/books/[id]/file). Der iframe ist so
 * hoch wie sein Inhalt, gescrollt wird außen – so stimmt die Position (Kapitel + Anteil) auf jedem Gerät, und iOS
 * scrollt flüssig. Lesezeit zählt nur, solange die Seite sichtbar ist und in den letzten 2 Minuten etwas passiert ist.
 */

type Stats = { todayMinutes: number; goalMinutes: number; done: boolean; streak: number };
type Target = { fraction?: number; anchor?: string };

const TICK_S = 5;
const REPORT_EVERY = 6; // Ticks → alle 30 s
const IDLE_MS = 2 * 60_000;
const FONT_KEY = "lifeos-reader-font";
const FONT_MIN = 14;
const FONT_MAX = 28;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pathOf = (href: string) => href.split("#")[0];

export function Reader({
  book,
  initial,
}: {
  book: { id: string; title: string; chapter: number; fraction: number; spine: Chapter[]; toc: TocItem[] };
  initial: Stats;
}) {
  const n = book.spine.length;
  const [chapter, setChapter] = useState(() => clamp(book.chapter, 0, n - 1));
  const [fraction, setFraction] = useState(book.fraction);
  const [font, setFont] = useState(18);
  const [tocOpen, setTocOpen] = useState(false);
  const [stats, setStats] = useState(initial);
  const [toast, setToast] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const tint = useRef<HTMLAnchorElement>(null);
  const target = useRef<Target | null>({ fraction: book.fraction });
  const pos = useRef({ chapter, fraction: book.fraction });
  const lastActive = useRef(0);
  const activeS = useRef(0);
  const wasDone = useRef(initial.done);
  const resize = useRef<ResizeObserver | null>(null);
  const fontRef = useRef(font);
  const loaded = useRef<Document | null>(null);

  const percent = () => clamp(((pos.current.chapter + pos.current.fraction) / n) * 100, 0, 100);

  const report = useCallback(
    (keepalive = false) => {
      const seconds = Math.min(120, Math.round(activeS.current));
      activeS.current -= seconds;
      const body = JSON.stringify({ chapter: pos.current.chapter, fraction: pos.current.fraction, percent: percent(), seconds });
      fetch(`/api/books/${book.id}/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive })
        .then((r) => (r.ok ? (r.json() as Promise<Stats>) : null))
        .then((s) => {
          if (!s) return;
          if (s.done && !wasDone.current) {
            setToast(`🎉 Tagesziel erreicht – ${s.streak} ${s.streak === 1 ? "Tag" : "Tage"} in Folge`);
            setTimeout(() => setToast(null), 5000);
          }
          wasDone.current = s.done;
          setStats(s);
        })
        .catch(() => {
          activeS.current += seconds; // beim nächsten Mal mitschicken
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- percent liest nur Refs
    [book.id, n],
  );

  // Lesezeit: alle 5 s zählen, alle 30 s melden, beim Verlassen sofort
  useEffect(() => {
    let ticks = 0;
    lastActive.current = Date.now();
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastActive.current < IDLE_MS) activeS.current += TICK_S;
      if (++ticks % REPORT_EVERY === 0 && activeS.current > 0) report();
    }, TICK_S * 1000);
    const leave = () => report(true);
    const vis = () => {
      if (document.visibilityState === "hidden") report(true);
      else lastActive.current = Date.now();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", vis);
      report(true);
    };
  }, [report]);

  useEffect(() => {
    let v = 0;
    try {
      v = Number(localStorage.getItem(FONT_KEY));
    } catch {}
    if (!(v >= FONT_MIN && v <= FONT_MAX)) return;
    // gemerkte Schriftgröße erst nach dem ersten Bild (Server kennt sie nicht)
    const raf = requestAnimationFrame(() => setFont(v));
    return () => cancelAnimationFrame(raf);
  }, []);

  const styleFrame = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const sc = scroller.current;
    if (!doc || !sc) return;
    const cs = getComputedStyle(sc);
    const link = tint.current ? getComputedStyle(tint.current).color : "#007aff";
    let el = doc.getElementById("lifeos-reader");
    if (!el) {
      el = doc.createElement("style");
      el.id = "lifeos-reader";
      (doc.head ?? doc.documentElement).appendChild(el);
    }
    el.textContent = `
      html,body{height:auto!important;min-height:0!important;overflow:hidden!important}
      html{background:${cs.backgroundColor}!important;color:${cs.color}!important;-webkit-text-size-adjust:100%;color-scheme:${document.documentElement.classList.contains("dark") ? "dark" : "light"}}
      body{max-width:36em;margin:0 auto!important;padding:24px 20px!important;font-size:${fontRef.current}px!important;line-height:1.6!important;
        font-family:ui-serif,"Iowan Old Style","New York",Georgia,serif;background:transparent!important;color:inherit!important;overflow-wrap:break-word;hyphens:auto}
      body :not(a){color:inherit!important;background-color:transparent!important}
      a{color:${link}!important}
      img,svg,video{max-width:100%!important;height:auto!important}
      pre{white-space:pre-wrap}`;
  }, []);

  const measure = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const max = sc.scrollHeight - sc.clientHeight;
    const f = max > 0 ? clamp(sc.scrollTop / max, 0, 1) : 1;
    pos.current.fraction = f;
    setFraction(f);
  }, []);

  const restore = useCallback((t: Target) => {
    const sc = scroller.current;
    const doc = frame.current?.contentDocument;
    if (!sc) return;
    const anchorEl = t.anchor ? (doc?.getElementById(t.anchor) ?? null) : null;
    if (anchorEl && frame.current) sc.scrollTop = frame.current.offsetTop + anchorEl.getBoundingClientRect().top - 8;
    else sc.scrollTop = (t.fraction ?? 0) * (sc.scrollHeight - sc.clientHeight);
    measure();
  }, [measure]);

  const goTo = useCallback(
    (idx: number, t: Target = { fraction: 0 }) => {
      if (idx < 0 || idx >= n) return;
      setTocOpen(false);
      if (idx === pos.current.chapter) return restore(t);
      target.current = t;
      pos.current = { chapter: idx, fraction: t.fraction ?? 0 };
      setChapter(idx);
      setFraction(t.fraction ?? 0);
      report();
    },
    [n, report, restore],
  );

  const page = useCallback(
    (dir: 1 | -1) => {
      const sc = scroller.current;
      if (!sc) return;
      lastActive.current = Date.now();
      const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (dir > 0 && atEnd) return goTo(pos.current.chapter + 1);
      if (dir < 0 && sc.scrollTop <= 4) return goTo(pos.current.chapter - 1, { fraction: 1 });
      sc.scrollBy({ top: dir * sc.clientHeight * 0.9, behavior: "smooth" });
    },
    [goTo],
  );

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) page(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) page(-1);
      else if (e.key === "Escape") setTocOpen(false);
      else return;
      e.preventDefault();
    },
    [page],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  // Links im Buch: Kapitel im Leser öffnen, fremde Seiten in einem neuen Tab
  const onLink = useCallback(
    (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const doc = frame.current?.contentDocument;
      if (!a || !doc) return;
      e.preventDefault();
      const url = new URL(a.getAttribute("href") ?? "", doc.baseURI);
      if (url.origin !== location.origin) {
        if (/^https?:$/.test(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
        return;
      }
      const prefix = `/api/books/${book.id}/file/`;
      if (!url.pathname.startsWith(prefix)) return;
      const path = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      const idx = book.spine.findIndex((c) => c.href === path);
      if (idx >= 0) goTo(idx, { anchor: url.hash.slice(1) || undefined, fraction: 0 });
    },
    [book.id, book.spine, goTo],
  );

  const onLoad = useCallback(() => {
    const f = frame.current;
    const doc = f?.contentDocument;
    if (!f || !doc || doc === loaded.current) return;
    loaded.current = doc;
    styleFrame();
    const fit = () => {
      f.style.height = `${doc.documentElement.scrollHeight}px`;
    };
    resize.current?.disconnect();
    resize.current = new ResizeObserver(fit);
    resize.current.observe(doc.documentElement);
    fit();
    const active = () => (lastActive.current = Date.now());
    doc.addEventListener("click", onLink);
    doc.addEventListener("keydown", onKey);
    for (const ev of ["pointerdown", "touchstart", "wheel"]) doc.addEventListener(ev, active, { passive: true });
    restore(target.current ?? { fraction: 0 });
    target.current = null;
  }, [onKey, onLink, restore, styleFrame]);

  // Kapitel aus dem Cache ist oft schon geladen, bevor React das onLoad anhängt (erstes Bild, Hydration)
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.readyState === "complete" && doc.URL !== "about:blank") onLoad();
  }, [chapter, onLoad]);
  useEffect(() => () => resize.current?.disconnect(), []);

  // Schriftgröße oder Hell/Dunkel geändert → Stil neu setzen, Stelle halten
  useEffect(() => {
    fontRef.current = font;
    const keep = pos.current.fraction;
    styleFrame();
    requestAnimationFrame(() => restore({ fraction: keep }));
    try {
      localStorage.setItem(FONT_KEY, String(font));
    } catch {}
  }, [font, restore, styleFrame]);
  useEffect(() => {
    const mo = new MutationObserver(() => styleFrame());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [styleFrame]);

  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onScroll = () => {
    lastActive.current = Date.now();
    measure();
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => report(), 2000); // Stelle merken, sobald das Scrollen ruht
  };

  const pct = Math.round(((chapter + fraction) / n) * 100);
  const current = pathOf(book.spine[chapter].href);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-bar pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150">
        <div className="flex h-11 items-center gap-1 px-1">
          <Link ref={tint} href="/lesen" className="flex h-11 items-center pr-2 text-body text-tint-text active:opacity-60">
            <ChevronLeft className="size-6 shrink-0" aria-hidden />
            Bibliothek
          </Link>
          <span className="min-w-0 flex-1 truncate text-center text-subhead font-semibold">{book.title}</span>
          <button type="button" aria-label="Schrift kleiner" disabled={font <= FONT_MIN} onClick={() => setFont((f) => Math.max(FONT_MIN, f - 2))} className="grid size-11 place-items-center rounded-full text-tint disabled:opacity-40 active:bg-muted">
            <AArrowDown className="size-5" aria-hidden />
          </button>
          <button type="button" aria-label="Schrift größer" disabled={font >= FONT_MAX} onClick={() => setFont((f) => Math.min(FONT_MAX, f + 2))} className="grid size-11 place-items-center rounded-full text-tint disabled:opacity-40 active:bg-muted">
            <AArrowUp className="size-5" aria-hidden />
          </button>
          <button type="button" aria-label="Inhaltsverzeichnis" aria-expanded={tocOpen} onClick={() => setTocOpen((o) => !o)} className="grid size-11 place-items-center rounded-full text-tint active:bg-muted">
            <List className="size-5" aria-hidden />
          </button>
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <iframe
          ref={frame}
          key={chapter}
          src={fileUrl(book.id, book.spine[chapter].href)}
          title={`${book.title} – Kapitel ${chapter + 1}`}
          sandbox="allow-same-origin"
          scrolling="no"
          onLoad={onLoad}
          className="block h-[70vh] w-full border-0"
        />
        <div className="mx-auto flex max-w-[36em] gap-3 px-5 pt-2 pb-10">
          {chapter > 0 ? (
            <button type="button" onClick={() => goTo(chapter - 1)} className="flex min-h-12 flex-1 items-center justify-center gap-1 rounded-[14px] bg-muted text-body active:opacity-70">
              <ChevronLeft className="size-5" aria-hidden /> Zurück
            </button>
          ) : null}
          {chapter < n - 1 ? (
            <button type="button" onClick={() => goTo(chapter + 1)} className="flex min-h-12 flex-[2] items-center justify-center gap-1 rounded-[14px] bg-tint text-body font-semibold text-white active:opacity-70">
              Nächstes Kapitel <ChevronRight className="size-5" aria-hidden />
            </button>
          ) : (
            <p className="flex-[2] py-3 text-center text-subhead text-muted-foreground">Ende des Buchs 📕</p>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-bar pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150">
        <div className="h-0.5 bg-muted">
          <div className="h-full bg-[var(--cat-reading)] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex h-11 items-center gap-1 px-1">
          <button type="button" aria-label="Vorheriges Kapitel" disabled={chapter === 0} onClick={() => goTo(chapter - 1)} className="grid size-11 place-items-center rounded-full text-tint disabled:opacity-40 active:bg-muted">
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <p className="min-w-0 flex-1 truncate text-center text-footnote text-muted-foreground tabular-nums">
            Kapitel {chapter + 1}/{n} · {pct} % · {stats.done ? "Ziel erreicht ✓" : `heute ${stats.todayMinutes}/${stats.goalMinutes} Min.`}
          </p>
          <button type="button" aria-label="Nächstes Kapitel" disabled={chapter >= n - 1} onClick={() => goTo(chapter + 1)} className="grid size-11 place-items-center rounded-full text-tint disabled:opacity-40 active:bg-muted">
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>
      </footer>

      {tocOpen ? (
        <div className="fixed inset-0 z-[60] flex items-end bg-black/30 md:items-stretch md:justify-end" onClick={() => setTocOpen(false)}>
          <nav
            aria-label="Inhaltsverzeichnis"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[75vh] w-full flex-col rounded-t-[20px] bg-card pb-[env(safe-area-inset-bottom)] md:max-h-none md:w-96 md:rounded-none md:pt-[env(safe-area-inset-top)]"
          >
            <div className="flex h-12 shrink-0 items-center px-4">
              <h2 className="flex-1 text-headline font-semibold">Inhalt</h2>
              <button type="button" aria-label="Schließen" onClick={() => setTocOpen(false)} className="-mr-2 grid size-11 place-items-center rounded-full text-muted-foreground active:bg-muted">
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
              {book.toc.map((t, i) => {
                const idx = book.spine.findIndex((c) => c.href === pathOf(t.href));
                const here = pathOf(t.href) === current;
                return (
                  <li key={i}>
                    <button
                      type="button"
                      disabled={idx < 0}
                      onClick={() => goTo(idx, { anchor: t.href.split("#")[1], fraction: 0 })}
                      aria-current={here ? "location" : undefined}
                      style={{ paddingLeft: `${16 + t.level * 16}px` }}
                      className={cn("flex min-h-11 w-full items-center pr-4 text-left text-body active:bg-muted disabled:opacity-40", here && "font-semibold text-tint-text")}
                    >
                      <span className="line-clamp-2">{t.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      ) : null}

      {toast ? (
        <div role="status" className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-[70] flex justify-center px-4">
          <p className="rounded-full bg-card px-4 py-2 text-subhead font-medium shadow-lg ring-1 ring-black/5 dark:ring-white/10">{toast}</p>
        </div>
      ) : null}
    </div>
  );
}
