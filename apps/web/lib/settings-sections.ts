import type { UserRole } from "@krubot/shared";
import { Blocks, BrainCircuit, KeyRound, LogIn, Monitor, Sparkles, UserRound, Users } from "lucide-react";

/*
 * Settings is one route with sections: /app/settings is the account,
 * /app/settings/<id> the rest. Kept out of the client component so the
 * server route can validate a section too. Everything but the account is
 * the admin's: it changes the server for everyone.
 */
export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account", blurb: "Your picture, password, theme and notifications.", icon: UserRound, admin: false },
  { id: "team", label: "Team", blurb: "The time zone, and how many bots work at once.", icon: Users, admin: true },
  { id: "ai", label: "AI", blurb: "What the bots run on: Claude Code, Codex or Grok, on your plan or an API key.", icon: BrainCircuit, admin: true },
  { id: "computer", label: "Computer", blurb: "What the bots' computer runs, and Update and Reset.", icon: Monitor, admin: true },
  { id: "skills", label: "Skills", blurb: "How to do a job, written once and shared by every bot.", icon: Sparkles, admin: true },
  { id: "apps", label: "Apps", blurb: "Connected apps through Composio, and your own MCP servers.", icon: Blocks, admin: true },
  { id: "secrets", label: "Secrets", blurb: "Keys the bots use but never see.", icon: KeyRound, admin: true },
  { id: "auth", label: "Authentication", blurb: "Who can sign in: the OIDC provider, and the people who have.", icon: LogIn, admin: true },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

/** The sections a person may open. */
export function sectionsFor(role: UserRole) {
  return SETTINGS_SECTIONS.filter((s) => role === "admin" || !s.admin);
}

export function canOpenSection(role: UserRole, section: SettingsSection) {
  return sectionsFor(role).some((s) => s.id === section);
}

/** Each section's address. /app/settings itself is the account on a desktop and the list on a phone. */
export function settingsHref(section: SettingsSection) {
  return `/app/settings/${section}`;
}
