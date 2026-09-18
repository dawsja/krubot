"use client";

import { useLiveEvents } from "@/components/hq/live-events";
import { mobileShell } from "@/lib/shell";

/**
 * In the Android app the page has no Web Push, so a `notify` live event
 * (what the API just sent to subscribed browsers) becomes a phone
 * notification through the bridge, unless that conversation is in front
 * of you right now. Mounted once, in the shell.
 */
export function MobileNotifications() {
  useLiveEvents((event) => {
    if (event.topic !== "notify") return;
    const shell = mobileShell();
    if (!shell) return;
    const target = new URL(event.url, window.location.origin);
    const inFront = document.visibilityState === "visible" && window.location.pathname === target.pathname;
    if (inFront) return;
    shell.notify(event.title, event.body, target.pathname + target.search, event.tag);
  });
  return null;
}
