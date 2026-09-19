import type { UserRole } from "@krubot/shared";
import { Blocks, BrainCircuit, KeyRound, LogIn, Monitor, Sparkles, UserRound, Users } from "lucide-react";

/*
 * Settings is one route with sections: /app/settings is the account,
 * /app/settings/<id> the rest. Kept out of the client component so the
 * server route can validate a section too. The account, the AI, the
 * computer (your own account on it), the apps and the secrets are each
 * person's own; the rest is the admin's, since it changes the server for
 * everyone. Inside Computer, Update and Reset are the admin's.
 */
export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account", blurb: "Your picture, password, theme and notifications.", icon: UserRound, admin: false },
  { id: "team", label: "Team", blurb: "The time zone, and how many bots work at once.", icon: Users, admin: true },
  { id: "ai", label: "AI", blurb: "What your bots run on: Claude Code, Codex or Grok, on your plan or your API key.", icon: BrainCircuit, admin: false },
  { id: "computer", label: "Computer", blurb: "Your account on the bots' computer: your sign-ins, and what runs there.", icon: Monitor, admin: false },
  { id: "skills", label: "Skills", blurb: "How to do a job, written once and shared by every bot.", icon: Sparkles, admin: true },
  { id: "apps", label: "Apps", blurb: "Your Composio key, your connected apps and your MCP servers.", icon: Blocks, admin: false },
  { id: "secrets", label: "Secrets", blurb: "Your keys the bots use but never see.", icon: KeyRound, admin: false },
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
