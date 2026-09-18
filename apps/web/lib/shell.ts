"use client";

import { useSyncExternalStore } from "react";

/*
 * The native shells around the web app. The desktop app (Electron) exposes
 * `kruDesktop` from its preload; the Android app exposes `kruMobile` from
 * its WebView. Neither exists in a browser. Pages ask here rather than
 * touching the globals, and render the browser's version on the server.
 */

export type KruMobile = {
  platform(): string;
  version(): string;
  /** Back to the app's Connect page, to point it at another Kru Bot. */
  changeServer(): void;
  /** A notification on the phone; tapping it opens `url` here. */
  notify(title: string, body: string, url: string, tag: string): void;
  /** Whether the phone lets the app notify: "granted", "denied" or "prompt". */
  notificationsState(): "granted" | "denied" | "prompt";
  /** Asks the phone; a `kru:notifications` event on window follows the answer. */
  requestNotifications(): void;
  openExternal(url: string): void;
  /** Signs in with the OIDC provider in the phone's browser, then opens `next`. Absent in older versions of the app. */
  signIn?(next: string): void;
  /** The page's background and whether it is dark, for the bars around it. */
  setTheme(background: string, dark: boolean): void;
};

declare global {
  interface Window {
    /** Set by the desktop app's preload; absent in a browser. */
    kruDesktop?: { changeServer: () => Promise<void> };
    /** Set by the Android app; absent in a browser. */
    kruMobile?: KruMobile;
  }
}

export type NativeShell = "desktop" | "android";

/** Which app wraps the page, if any; null in a browser and on the server. */
export function nativeShell(): NativeShell | null {
  if (typeof window === "undefined") return null;
  if (window.kruMobile) return "android";
  if (typeof window.kruDesktop?.changeServer === "function") return "desktop";
  return null;
}

export function mobileShell(): KruMobile | null {
  return typeof window === "undefined" ? null : (window.kruMobile ?? null);
}

const never = () => () => {};

/** The shell around the page: null on the server and in a browser. */
export function useNativeShell(): NativeShell | null {
  return useSyncExternalStore(never, nativeShell, () => null);
}

/** Sends the pages back to the shell's Connect page. */
export function changeServer() {
  if (window.kruMobile) window.kruMobile.changeServer();
  else void window.kruDesktop?.changeServer();
}
