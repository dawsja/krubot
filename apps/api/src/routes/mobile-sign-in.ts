import { OIDC_PROVIDER_ID } from "@krubot/shared";
import { Hono } from "hono";
import { getAuth, getSession } from "../auth.ts";
import { appUrl } from "../config.ts";
import { oidcReady } from "../data/oidc.ts";
import { isChallenge, issueCode, redeemCode, safePath, signInApp, signInCallback, type SignInApp } from "../mobile-sign-in.ts";

/*
 * The apps' sign-in with the OIDC provider (see mobile-sign-in.ts). Public:
 * `start` and `finish` run in the browser outside the app, `redeem` in the
 * app itself, and none of them has a session to begin with.
 *
 *   start   browser: remembers the challenge, sends you to the provider
 *   finish  browser: back from the provider, signed in; a one-time code to the app
 *   redeem  app: the code and the verifier become the app's session cookie
 *
 * `?app=desktop` says the desktop asked, so the code goes to its loopback
 * instead of the phones' scheme; the cookie carries that across the provider.
 */

const CHALLENGE_COOKIE = "kru_mobile_sign_in";
const BASE = "/api/mobile-sign-in";

function secure() {
  return appUrl().startsWith("https://");
}

/** The raw value of cookie `name` in a Cookie header, as the browser sent it. */
function rawCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function challengeCookie(value: string, maxAge: number) {
  return `${CHALLENGE_COOKIE}=${value}; Path=${BASE}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure() ? "; Secure" : ""}`;
}

/** The cookie holds which app asked and its challenge, since only it comes back from the provider. */
function packChallenge(app: SignInApp, challenge: string) {
  return `${app}.${challenge}`;
}

function unpackChallenge(value: string | null): { app: SignInApp; challenge: string | null } {
  const at = value?.indexOf(".") ?? -1;
  if (!value || at < 0) return { app: "app", challenge: value };
  return { app: signInApp(value.slice(0, at)), challenge: value.slice(at + 1) };
}

function toApp(app: SignInApp, params: Record<string, string>, cookies: string[] = []) {
  const headers = new Headers({ Location: `${signInCallback(app)}?${new URLSearchParams(params)}`, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function mobileSignInRoutes() {
  const app = new Hono();

  app.get(`${BASE}/start`, async (c) => {
    const challenge = c.req.query("challenge");
    const which = signInApp(c.req.query("app"));
    if (!isChallenge(challenge)) return c.json({ error: "Bad challenge" }, 400);
    if (!oidcReady()) return toApp(which, { error: "off" });
    // The provider sends the browser back to APP_URL; start there so the sign-in's cookies are on it.
    const home = new URL(appUrl());
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
    if (host !== home.host && !c.req.query("hop")) return c.redirect(`${home.origin}${BASE}/start?challenge=${challenge}&app=${which}&hop=1`, 302);

    const auth = await getAuth();
    const res = await auth.api.signInSocial({
      body: { provider: OIDC_PROVIDER_ID, callbackURL: `${BASE}/finish`, errorCallbackURL: `${BASE}/finish`, newUserCallbackURL: `${BASE}/finish` },
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const data = (await res.clone().json().catch(() => null)) as { url?: string } | null;
    if (!res.ok || !data?.url) return toApp(which, { error: "provider" });
    const headers = new Headers({ Location: data.url, "Cache-Control": "no-store" });
    for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    headers.append("Set-Cookie", challengeCookie(packChallenge(which, challenge), 600));
    return new Response(null, { status: 302, headers });
  });

  app.get(`${BASE}/finish`, async (c) => {
    const { app: which, challenge } = unpackChallenge(rawCookie(c.req.header("cookie"), CHALLENGE_COOKIE));
    const forget = challengeCookie("", 0);
    if (c.req.query("error") || !isChallenge(challenge)) return toApp(which, { error: "provider" }, [forget]);
    const session = await getSession(c.req.raw.headers);
    const { sessionToken } = (await (await getAuth()).$context).authCookies;
    const value = rawCookie(c.req.header("cookie"), sessionToken.name);
    if (!session || !value) return toApp(which, { error: "provider" }, [forget]);
    // The session is the app's now; the browser keeps no copy of it.
    const expire = `${sessionToken.name}=; Path=${sessionToken.attributes.path ?? "/"}; Max-Age=0; HttpOnly; SameSite=Lax${sessionToken.attributes.secure ? "; Secure" : ""}`;
    return toApp(which, { code: issueCode(value, challenge) }, [forget, expire]);
  });

  app.get(`${BASE}/redeem`, async (c) => {
    const next = safePath(c.req.query("next"));
    const session = redeemCode(c.req.query("code") ?? "", c.req.query("verifier") ?? "");
    if (!session) return c.redirect("/login?error=oidc", 302);
    const { sessionToken } = (await (await getAuth()).$context).authCookies;
    const { attributes } = sessionToken;
    const cookie = [
      `${sessionToken.name}=${session}`,
      `Path=${attributes.path ?? "/"}`,
      attributes.maxAge ? `Max-Age=${attributes.maxAge}` : null,
      "HttpOnly",
      "SameSite=Lax",
      attributes.secure ? "Secure" : null,
    ]
      .filter(Boolean)
      .join("; ");
    return new Response(null, { status: 302, headers: { Location: next, "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  });

  return app;
}
