"use client";

import { BookOpen, FolderClosed, GraduationCap, Heart, ListChecks, MessageCircle, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { haptic } from "@/lib/haptics";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { capsuleOffset, DRAG_THRESHOLD, tabAt } from "@/lib/tab-bar";
import { cn } from "@/lib/utils";

export const TABS = [
  { href: "/", label: "Heute", icon: Sun },
  { href: "/schule", label: "Schule", icon: GraduationCap },
  { href: "/habits", label: "Habits", icon: ListChecks },
  { href: "/lernen", label: "Lernen", icon: BookOpen },
  { href: "/health", label: "Gesundheit", icon: Heart },
] as const;

const isActive = (href: string, path: string) => (href === "/" ? path === "/" : path.startsWith(href));

type Drag = { id: number; x: number; started: boolean; idx: number };

/** Innere Fläche der Leiste (ohne das p-1-Polster), in der die Tabs liegen. */
function track(nav: HTMLElement) {
  const r = nav.getBoundingClientRect();
  return { left: r.left + 4, width: r.width - 8 };
}

/**
 * Tab-Leiste wie in iOS 26: schwebt über dem Inhalt, Glas-Hintergrund, eine gleitende Kapsel unter dem aktiven Tab.
 * Daumen auf die Leiste und ziehen: Die Kapsel folgt dem Finger, jeder neue Tab gibt einen Haptik-Tick, Loslassen
 * öffnet den Tab darunter. Ein normaler Tipp bleibt ein Link (Tastatur und VoiceOver unverändert).
 * Steht außerhalb von Elementen mit backdrop-filter (sonst richtet sich `fixed` daran aus).
 */
export function BottomNav() {
  const path = usePathname();
  const router = useRouter();
  const kb = useKeyboardInset();
  const navRef = useRef<HTMLElement>(null);
  const capsuleRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  // Ziel sofort anzeigen, bevor die neue Seite da ist (gilt nur, solange der Pfad derselbe ist)
  const [pending, setPending] = useState<{ href: string; from: string } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const current = TABS.findIndex((t) => isActive(t.href, path));
  const pendingIdx = pending && pending.from === path ? TABS.findIndex((t) => t.href === pending.href) : -1;
  const active = pendingIdx >= 0 ? pendingIdx : current;
  const shown = hover ?? active;

  const go = (idx: number) => {
    const href = TABS[idx].href;
    if (idx === current) return;
    setPending({ href, from: path });
    router.push(href);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    swallowClick.current = false;
    drag.current = { id: e.pointerId, x: e.clientX, started: false, idx: active };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const nav = navRef.current;
    if (!d || d.id !== e.pointerId || !nav) return;
    if (!d.started) {
      if (Math.abs(e.clientX - d.x) < DRAG_THRESHOLD) return;
      d.started = true;
      nav.setPointerCapture(e.pointerId);
    }
    const { left, width } = track(nav);
    capsuleRef.current?.style.setProperty("--x", `${capsuleOffset(e.clientX, left, width, TABS.length)}px`);
    const idx = tabAt(e.clientX, left, width, TABS.length);
    if (idx !== d.idx || hover === null) {
      if (idx !== d.idx) haptic();
      d.idx = idx;
      setHover(idx);
      router.prefetch(TABS[idx].href);
    }
  };

  const end = (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.started) return;
    if (!cancelled) {
      // der Klick direkt nach dem Loslassen soll nicht noch einmal navigieren
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 400);
    }
    const idx = cancelled ? active : d.idx;
    capsuleRef.current?.style.setProperty("--x", `${idx * 100}%`);
    setHover(null);
    if (!cancelled) go(idx);
  };

  return (
    <nav
      ref={navRef}
      aria-label="Hauptnavigation"
      inert={kb.isOpen}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, false)}
      onPointerCancel={(e) => end(e, true)}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      className={cn("fixed inset-x-3 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-30 mx-auto grid max-w-md touch-none grid-cols-5 rounded-full bg-bar p-1 shadow-[0_8px_30px_rgb(0_0_0/0.12)] ring-1 ring-black/5 backdrop-blur-xl backdrop-saturate-150 select-none [-webkit-touch-callout:none] md:max-w-lg desktop:hidden dark:ring-white/10", "transition-[transform,opacity] duration-200 motion-reduce:transition-none", kb.isOpen && "pointer-events-none translate-y-24 opacity-0")}
    >
      {active >= 0 ? (
        <span
          ref={capsuleRef}
          aria-hidden
          style={{ "--x": `${active * 100}%` } as React.CSSProperties}
          className={cn(
            "pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/5)] [transform:translateX(var(--x))_scale(var(--s,1))] rounded-full bg-muted transition-transform duration-500 ease-[cubic-bezier(0.3,1.35,0.5,1)] motion-reduce:transition-none",
            hover !== null && "bg-muted/80 shadow-[0_4px_16px_rgb(0_0_0/0.12)] ring-1 ring-white/30 transition-none [--s:1.12] dark:ring-white/15",
          )}
        />
      ) : null}
      {TABS.map(({ href, label, icon: Icon }, i) => {
        const on = i === shown;
        return (
          <Link
            key={href}
            href={href}
            draggable={false}
            aria-current={i === current ? "page" : undefined}
            onClick={() => {
              if (i !== current) setPending({ href, from: path });
            }}
            className={cn(
              "relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-caption2 font-medium text-foreground/80 transition-colors duration-200",
              on && "text-tint",
            )}
          >
            <Icon className="size-[1.375rem]" fill={on ? "currentColor" : "none"} fillOpacity={on ? 0.2 : 0} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Mit Maus/Trackpad (Laptop): Tabs oben in der Leiste. */
export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Hauptnavigation" className="hidden items-center gap-1 desktop:flex">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = isActive(href, path);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5 text-subhead text-muted-foreground hover:bg-muted hover:text-foreground",
              active && "bg-muted font-medium text-foreground",
            )}
          >
            <Icon className={cn("size-4", active && "text-tint")} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Zahnrad zu den Einstellungen – selten gebraucht, darum kein eigener Tab. */
export function SettingsLink({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <Link
      href="/settings"
      aria-label="Einstellungen"
      aria-current={path.startsWith("/settings") ? "page" : undefined}
      className={cn(
        "grid size-11 place-items-center rounded-full text-tint hover:bg-muted active:bg-muted aria-[current=page]:bg-muted",
        className,
      )}
    >
      <Settings className="size-[1.375rem]" aria-hidden />
    </Link>
  );
}

/** Agent-Unterhaltungen (am Rechner in der Kopfleiste; mobil über den Chat-Knopf erreichbar). */
export function AgentLink({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <Link
      href="/agent"
      aria-label="Agent"
      aria-current={path.startsWith("/agent") ? "page" : undefined}
      className={cn(
        "grid size-11 place-items-center rounded-full text-tint hover:bg-muted active:bg-muted aria-[current=page]:bg-muted",
        className,
      )}
    >
      <MessageCircle className="size-[1.375rem]" aria-hidden />
    </Link>
  );
}

/** Dateien (Nextcloud) – am Rechner in der Kopfleiste, mobil neben dem Zahnrad auf Heute und Schule. */
export function FilesLink({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <Link
      href="/dateien"
      aria-label="Dateien"
      aria-current={path.startsWith("/dateien") ? "page" : undefined}
      className={cn(
        "grid size-11 place-items-center rounded-full text-tint hover:bg-muted active:bg-muted aria-[current=page]:bg-muted",
        className,
      )}
    >
      <FolderClosed className="size-[1.375rem]" aria-hidden />
    </Link>
  );
}
