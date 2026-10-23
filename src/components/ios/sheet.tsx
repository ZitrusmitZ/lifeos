"use client";

import { Drawer } from "@base-ui/react/drawer";
import type { ReactNode } from "react";
import { keyboardFitStyle, useKeyboardInset } from "@/lib/use-keyboard-inset";
import { cn } from "@/lib/utils";

/**
 * Sheet wie in iOS: kommt von unten, Griff oben, nach unten wischen schließt es.
 * Auf dem iPad und am Rechner bleibt es schmal und mittig. Mit Tastatur-Ausgleich für Formulare.
 * `fill`: das Sheet nimmt die volle Höhe und der Inhalt (z. B. ein Chat) verwaltet Scrollen und Eingabe selbst;
 * es folgt dann dem sichtbaren Bereich über der Tastatur.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  fill = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  fill?: boolean;
}) {
  const kb = useKeyboardInset();
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.VirtualKeyboardProvider>
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 min-h-dvh bg-black opacity-[calc(0.3*(1-var(--drawer-swipe-progress)))] transition-opacity duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0 motion-reduce:transition-none supports-[-webkit-touch-callout:none]:absolute dark:opacity-[calc(0.6*(1-var(--drawer-swipe-progress)))]" />
          <Drawer.Viewport className="fixed inset-0 z-40 flex items-end justify-center" style={fill ? keyboardFitStyle(kb) : undefined}>
            <Drawer.Popup className={cn("flex max-h-[calc(100dvh-max(2.5rem,env(safe-area-inset-top)))] w-full max-w-xl flex-col rounded-t-[22px] bg-background text-foreground shadow-[0_-8px_40px_rgb(0_0_0/0.18)] outline-none [transform:translateY(var(--drawer-swipe-movement-y))] transition-transform duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:[transform:translateY(100%)] data-starting-style:[transform:translateY(100%)] data-swiping:select-none motion-reduce:transition-none", fill && "h-full")}>
              <div className="relative shrink-0 touch-none px-4 pt-2 pb-2 select-none">
                <div className="mx-auto h-[5px] w-9 rounded-full bg-foreground/20" aria-hidden />
                <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center">
                  <Drawer.Close className="min-h-11 justify-self-start text-body text-tint-text active:opacity-60">Abbrechen</Drawer.Close>
                  <Drawer.Title className="text-body font-semibold">{title}</Drawer.Title>
                </div>
              </div>
              <Drawer.Content
                className={cn(
                  "min-h-0 flex-1 touch-auto",
                  fill
                    ? "overflow-hidden pr-[max(0px,env(safe-area-inset-right))] pl-[max(0px,env(safe-area-inset-left))]"
                    : "overflow-y-auto overscroll-contain px-4 pt-1 pb-[calc(1.5rem+env(safe-area-inset-bottom)+var(--drawer-keyboard-inset,0px))]",
                )}
              >
                {children}
              </Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.VirtualKeyboardProvider>
    </Drawer.Root>
  );
}
