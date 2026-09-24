import type { UserRole } from "@krubot/shared";
import { Blocks, BrainCircuit, LogIn, Sparkles, UserRound, Users } from "lucide-react";

/*
 * Settings is one route with sections: /app/settings is the account,
 * /app/settings/<id> the rest. Kept out of the client component so the
 * server route can validate a section too. The account, the AI and the
 * apps are each person's own; the rest is the admin's, since it changes
 * the server for everyone. The computer itself is opened from a bot, not
 * from here; keeping it running (Update and Reset) is under Team, the
 * admin's.
 */
export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account", blurb: "Your picture, password, theme and notifications.", icon: UserRound, admin: false },
  { id: "team", label: "Team", blurb: "The time zone, how many bots work at once, and the computer they all share.", icon: Users, admin: true },
  { id: "ai", label: "AI", blurb: "What your bots run on: a coding CLI on your plan, or your API key called directly.", icon: BrainCircuit, admin: false },
  { id: "skills", label: "Skills", blurb: "How to do a job, written once and shared by all of your bots.", icon: Sparkles, admin: false },
  { id: "apps", label: "Apps", blurb: "Your Composio key, your connected apps and your MCP servers.", icon: Blocks, admin: false },
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
