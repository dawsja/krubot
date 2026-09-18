import type { AuthConfig, Me } from "@krubot/shared";
import { cookies } from "next/headers";
import { apiUrl } from "@/lib/api-url";

/*
 * Server-side calls to the API, with the browser's cookies forwarded. Pages
 * use these to decide where to send the person before rendering anything.
 */

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
    cache: "no-store",
  });
}

/** The signed-in person: who, their role, how they signed in, and their picture's versioned URL. */
export type SessionUser = Me;

/** The signed-in person, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const res = await apiFetch("/api/me");
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: SessionUser };
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** What the sign-in page shows: the provider's button, when the admin set one up. Null when the API is down. */
export async function getAuthConfig(): Promise<AuthConfig | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/auth-config`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AuthConfig;
  } catch {
    return null;
  }
}

/** How many accounts exist; null when the API is down. */
export async function countAccounts(): Promise<number | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/account`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { accounts: number }).accounts;
  } catch {
    return null;
  }
}

/**
 * A same-site path to continue to after a redirect, or `fallback`. Rejects
 * absolute URLs and protocol-relative values like "//evil.example".
 */
export function safeNext(value: string | null | undefined, fallback = "/app") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  try {
    const base = "http://kru.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
