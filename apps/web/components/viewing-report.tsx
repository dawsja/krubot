"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { pushPermission } from "@/lib/push";
import { mobileShell } from "@/lib/shell";

/** Renewed this often while a conversation stays in front; the API forgets a report after a minute. */
const HEARTBEAT_MS = 20_000;

/**
 * Tells the API which conversation this window has in front of you, so a
 * reply there isn't pushed to your phone as well (`src/presence.ts`). Only
 * where Web Push is on; the Android app decides for itself in
 * MobileNotifications. Mounted once, in the shell.
 */
export function ViewingReport() {
  const pathname = usePathname();
  useEffect(() => {
    if (mobileShell() || pushPermission() !== "granted") return;
    const client = windowId();
    const threadId = /^\/app\/t\/([^/]+)/.exec(pathname)?.[1] ?? null;
    let last: string | null = null;
    const report = (force = false, leaving = false) => {
      const shown = threadId && !leaving && document.visibilityState === "visible" && document.hasFocus() ? threadId : null;
      if (!force && shown === last) return;
      last = shown;
      // keepalive, so the report still leaves when the page is being hidden.
      void fetch("/api/push/viewing", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client, threadId: shown }) }).catch(() => undefined);
    };
    const onChange = () => report();
    const onLeave = () => report(false, true);
    report(true);
    const heartbeat = window.setInterval(() => {
      if (last) report(true);
    }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [pathname]);
  return null;
}

let id: string | null = null;

/** This window's own id, made once per page load. */
function windowId() {
  id ??= crypto.randomUUID();
  return id;
}
