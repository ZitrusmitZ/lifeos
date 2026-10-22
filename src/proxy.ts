import { NextResponse, type NextRequest } from "next/server";
import { accessConfigFromEnv, checkOrigin, SHARE_PATH } from "@/lib/access";
import { checkAccessLive } from "@/lib/tailscale-identity";

const text = (body: string, status: number) =>
  new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function proxy(request: NextRequest) {
  const decision = await checkAccessLive(request.nextUrl.pathname, request.headers.get("tailscale-user-login"), accessConfigFromEnv());
  if (!decision.allowed) return text(decision.reason, decision.status);
  // Freigabe-Links ändern nichts außer dem Freischalt-Cookie; über Funnel stimmt der Host nicht mit APP_URL überein.
  if (SHARE_PATH.test(request.nextUrl.pathname)) return NextResponse.next();

  const origin = checkOrigin(
    request.method,
    request.headers.get("origin"),
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    process.env.APP_URL ?? "http://localhost:3000",
  );
  if (!origin.allowed) return text("Anfrage von fremder Herkunft abgelehnt.", 403);

  if (origin.forwardedHost) {
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", origin.forwardedHost);
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
