"use client";

import { APP_CATALOG, appLogoUrl } from "@krubot/shared";
import { Plug } from "lucide-react";
import { useState } from "react";

/*
 * The apps' real logos, as Composio serves them for every toolkit it
 * offers (the same images its own dashboard shows). When one can't load,
 * a coloured tile with the app's initial stands in. The logos are
 * trademarks of their owners and are shown only to identify the app.
 */
const COLORS: Record<string, string> = {
  gmail: "#EA4335",
  googlecalendar: "#4285F4",
  googledrive: "#34A853",
  googlesheets: "#0F9D58",
  slack: "#4A154B",
  notion: "#111111",
  github: "#24292F",
  linear: "#5E6AD2",
  jira: "#0052CC",
  asana: "#F06A6A",
  trello: "#0079BF",
  hubspot: "#FF7A59",
  salesforce: "#00A1E0",
  zoom: "#2D8CFF",
  microsoft_teams: "#6264A7",
  outlook: "#0078D4",
  figma: "#F24E1E",
  canva: "#00C4CC",
  linkedin: "#0A66C2",
  twitter: "#111111",
  discord: "#5865F2",
  dropbox: "#0061FF",
  stripe: "#635BFF",
  shopify: "#96BF48",
  zendesk: "#03363D",
  intercom: "#1F8DED",
  airtable: "#FCB400",
  clickup: "#7B68EE",
};

export function appName(toolkit: string) {
  return APP_CATALOG.find((a) => a.toolkit === toolkit)?.name ?? toolkit;
}

export function AppIcon({ toolkit, logo, size = 24, className }: { toolkit: string; logo?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const name = appName(toolkit);
  const src = logo ?? appLogoUrl(toolkit);
  if (failed) {
    return (
      <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white ${className ?? ""}`} style={{ width: size, height: size, background: COLORS[toolkit] ?? "#6B7280", fontSize: Math.round(size * 0.5) }}>
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`inline-block shrink-0 rounded-md object-contain ${className ?? ""}`} style={{ width: size, height: size }} />
  );
}

/**
 * One of your own MCP servers: the logo the API finds for it (an app from
 * the catalog by name, or its host's site icon; see the API's mcp-icon.ts),
 * or the plug when there is none. A command has no host, so it keeps the
 * plug without asking. The size in pixels matches AppIcon.
 */
export function McpIcon({ id, transport, size = 24, className }: { id: string; transport: "http" | "stdio"; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (transport !== "http" || failed) return <Plug aria-hidden="true" className={`shrink-0 text-muted-foreground ${className ?? ""}`} style={{ width: size, height: size }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/mcp-servers/${id}/icon`} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className={`inline-block shrink-0 rounded-md object-contain ${className ?? ""}`} style={{ width: size, height: size }} />
  );
}
