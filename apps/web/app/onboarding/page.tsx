import { redirect } from "next/navigation";
import { connection } from "next/server";
import { apiFetch, getSessionUser } from "@/lib/session";
import { Onboarding } from "./onboarding";

export default async function OnboardingPage() {
  await connection();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/onboarding");
  if (user.role !== "admin") redirect("/app");
  const settings = await apiFetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { settings?: { onboarding: { done: boolean } } } | null) => d?.settings ?? null);
  if (settings?.onboarding.done) redirect("/app");
  return <Onboarding />;
}
