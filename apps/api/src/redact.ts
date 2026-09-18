/** Longest log line kept; the rest is cut. */
export const MAX_LOG_LINE = 4_000;

/** Common token formats, masked even when Kru Bot doesn't know the exact value. */
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}\b/g,
  /\bak_[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Returns a function that masks the given secrets and common token formats
 * in a line, then caps its length.
 */
export function createRedactor(secrets: readonly (string | null | undefined)[]) {
  const known = secrets
    .filter((secret): secret is string => Boolean(secret) && (secret as string).length >= 8)
    .sort((a, b) => b.length - a.length);
  return (line: string) => {
    let out = line;
    for (const secret of known) out = out.split(secret).join("***");
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "***");
    return out.length > MAX_LOG_LINE ? `${out.slice(0, MAX_LOG_LINE)}…` : out;
  };
}

export const redact = createRedactor([]);
