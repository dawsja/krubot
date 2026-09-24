import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { SettingsPage } from "@/components/settings-page";
import { canOpenSection, isSettingsSection } from "@/lib/settings-sections";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };

/** /app/settings/<section> is one section; /app/settings is the account on a desktop and the list on a phone. */
export default async function Settings({ params }: { params: Promise<{ section?: string[] }> }) {
  const { section: parts = [] } = await params;
  const section = parts[0] ?? "account";
  if (parts.length > 1 || !isSettingsSection(section)) notFound();
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/app/settings${parts.length ? `/${parts[0]}` : ""}`);
  // A user has only the account; the admin's sections are not there for them.
  if (!canOpenSection(user.role, section)) notFound();
  return <SettingsPage user={user} section={section} index={parts.length === 0} />;
}
