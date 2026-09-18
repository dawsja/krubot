import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Signing in with the OIDC provider from the Android app. The provider's page
 * runs in the phone's browser, which has passkeys and which providers trust,
 * but its cookies aren't the app's. So the app makes a verifier, sends only
 * its hash (the challenge) to the browser, and once the browser is signed in
 * the API trades that session for a one-time code the app redeems with the
 * verifier, the way PKCE works. A code caught by another app on its way back
 * is useless without the verifier, which never left the app.
 */

const CODE_TTL_MS = 2 * 60 * 1000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Pending = { session: string; challenge: string; expires: number };
const holder = globalThis as typeof globalThis & { __kruMobileCodes?: Map<string, Pending> };
const codes = (holder.__kruMobileCodes ??= new Map());

/** A challenge is the base64url SHA-256 of the app's verifier: 43 characters. */
export function isChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE.test(value);
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A one-time code for `session` (the session cookie's value), bound to `challenge`. */
export function issueCode(session: string, challenge: string, now = Date.now()): string {
  for (const [code, pending] of codes) if (pending.expires <= now) codes.delete(code);
  const code = randomBytes(32).toString("base64url");
  codes.set(code, { session, challenge, expires: now + CODE_TTL_MS });
  return code;
}

/** The session behind `code` when `verifier` matches its challenge; the code is spent either way. */
export function redeemCode(code: string, verifier: string, now = Date.now()): string | null {
  const pending = codes.get(code);
  if (!pending) return null;
  codes.delete(code);
  if (pending.expires <= now) return null;
  const given = Buffer.from(challengeFor(verifier));
  const expected = Buffer.from(pending.challenge);
  return given.length === expected.length && timingSafeEqual(given, expected) ? pending.session : null;
}

/** Where to go after signing in: a path on this server, never another site. */
export function safePath(value: unknown, fallback = "/app"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
