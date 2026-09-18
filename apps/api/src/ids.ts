import { randomBytes } from "node:crypto";

export function randomString(bytes = 12) {
  return randomBytes(bytes).toString("base64url");
}

/** Ids safe for paths, agent names and URLs: letters, digits, dash. */
export function newId(prefix = "") {
  const body = randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
  return prefix ? `${prefix}-${body}` : body;
}

export function now() {
  return new Date().toISOString();
}

/** Compares two strings in time that doesn't depend on where they differ. Callers check the lengths first. */
export function timingSafeEqualString(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
