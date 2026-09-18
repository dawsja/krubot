import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Shell } from "@/components/shell";
import { apiFetch, getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Bots", description: "Message your bots like teammates." };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/app");
  const settings = await apiFetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { settings?: { onboarding: { done: boolean } } } | null) => d?.settings ?? null);
  if (user.role === "admin" && settings && !settings.onboarding.done) redirect("/onboarding");
  return <Shell user={user}>{children}</Shell>;
}
