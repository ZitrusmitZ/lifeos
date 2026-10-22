import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AgentChatButton } from "@/components/agent-chat";
import { FocusDock } from "@/components/focus/focus-dock";
import { AgentLink, BottomNav, FilesLink, Nav, SettingsLink } from "@/components/nav";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { themeScript } from "@/components/theme";
import { isDemo } from "@/lib/env";
import "./globals.css";

// Geist nur als Rückfall außerhalb von Apple-Geräten; auf iPhone/Mac greift SF Pro (siehe globals.css)
const sans = Geist({ variable: "--font-geist", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "LifeOS", template: "%s · LifeOS" },
  description: "Persönliches Life-Dashboard: Schule, Kalender, Gesundheit, Gewohnheiten, Code und Musik an einem Ort.",
  appleWebApp: { capable: true, title: "LifeOS", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

async function UserBadge() {
  await connection();
  if (isDemo()) {
    return (
      <span className="rounded-full bg-series-4/15 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-foreground ring-1 ring-series-4/40">
        Demo
      </span>
    );
  }
  const h = await headers();
  const name = h.get("tailscale-user-name") ?? h.get("tailscale-user-login");
  return name ? <span className="hidden text-xs text-muted-foreground desktop:inline">{name}</span> : null;
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" className={`${sans.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        {/* Mit Maus/Trackpad: klassische Leiste oben. Auf iPhone und iPad übernehmen große Titel + Tab-Leiste unten. */}
        <header className="sticky top-0 z-20 hidden border-b border-border bg-bar backdrop-blur-xl backdrop-saturate-150 desktop:block">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid size-7 place-items-center rounded-lg bg-foreground text-sm text-background">L</span>
              <span className="hidden lg:inline">LifeOS</span>
            </Link>
            <Nav />
            <div className="ml-auto flex items-center gap-2">
              <Suspense>
                <UserBadge />
              </Suspense>
              <FilesLink />
              <AgentLink />
              <SettingsLink />
            </div>
          </div>
        </header>
        <div className="mx-auto flex min-h-full max-w-7xl flex-col pr-[max(16px,env(safe-area-inset-right))] pb-[calc(104px+env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] md:pr-[max(24px,env(safe-area-inset-right))] md:pl-[max(24px,env(safe-area-inset-left))] desktop:px-6 desktop:pb-12">
          <PullToRefresh />
          <main className="flex-1 pt-3 desktop:pt-6">{children}</main>
        </div>
        <BottomNav />
        <FocusDock />
        <AgentChatButton />
      </body>
    </html>
  );
}
