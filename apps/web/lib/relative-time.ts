/** "just now", "5 min ago", "in 2 h", then a date once it is more than a day away. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  const diff = at - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (minutes < 1) return "just now";
  const span = minutes < 60 ? `${minutes} min` : minutes < 24 * 60 ? `${Math.round(minutes / 60)} h` : null;
  if (span) return diff > 0 ? `in ${span}` : `${span} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
