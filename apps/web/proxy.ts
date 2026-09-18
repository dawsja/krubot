import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { apiUrl } from "@/lib/api-url";

// Pages that need no login. The API checks sessions itself.
const PUBLIC_PATH = /^\/(login|register|api|healthz)(\/|$)/;

/**
 * Optimistic gate for pages: no session cookie means a redirect to /login.
 * This only checks that a cookie exists; the API verifies every session.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // One origin: /api/* goes to the API on the Compose network. This runs per
  // request, so KRU_API_URL is read at runtime; next.config rewrites are
  // frozen at build time and would point a published image at 127.0.0.1.
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.rewrite(new URL(`${pathname}${search}`, apiUrl()));
  }
  if (PUBLIC_PATH.test(pathname) || getSessionCookie(request)) return NextResponse.next();
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|logo\\.png|robots\\.txt).*)"],
};
