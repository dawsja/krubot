"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LiveEvent } from "@krubot/shared";

/*
 * One connection to /api/events for the whole page, shared by everything
 * that wants to know when the board or the Team room changed. `open` is
 * sent each time the stream (re)connects: whatever was missed while it was
 * down, the listener fetches again. While the stream is down the callers
 * fall back to polling at their old pace, so nothing depends on it.
 *
 * A stream can die without saying so: a phone sleeps, a network changes,
 * and the browser still thinks it is open. The server pings every 25
 * seconds; a stream silent for much longer is dropped and made again, and
 * coming back to the page (it shows again, the network returns, the page
 * is restored from the back/forward cache) fetches again either way.
 */

export type LiveMessage = LiveEvent | { topic: "open" };

type Listener = (message: LiveMessage) => void;

const listeners = new Set<Listener>();
const connectionListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;
/** When the stream last said anything, pings included. */
let lastSeen = 0;
/** When the page was last hidden, to tell a glance away from a long absence. */
let hiddenAt = 0;
/** Consecutive refusals, for the wait before the next try. */
let refusals = 0;
let watching = false;

/** The server pings every 25 s; this long without a word means the stream is gone. */
const SILENT_MS = 60_000;
/** Hidden for longer than this, the page fetches again when it shows. */
const AWAY_MS = 10_000;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const listener of connectionListeners) listener();
}

function dispatch(message: LiveMessage) {
  for (const listener of [...listeners]) listener(message);
}

/** Drops the stream and makes a new one, which fetches everything again on open. */
function reconnect() {
  source?.close();
  source = null;
  setConnected(false);
  if (listeners.size > 0) connect();
}

/** Coming back to the page: make sure what it shows is current. */
function resume() {
  if (listeners.size === 0) return;
  if (!source || Date.now() - lastSeen > SILENT_MS / 2) reconnect();
  else dispatch({ topic: "open" });
}

/** Once per page: the watchdog and the ways a page comes back. */
function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.setInterval(() => {
    if (source && connected && Date.now() - lastSeen > SILENT_MS) reconnect();
  }, SILENT_MS / 4);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) resume();
  });
  window.addEventListener("online", () => resume());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
  });
}

function connect() {
  if (source || typeof EventSource === "undefined") return;
  watch();
  const stream = new EventSource("/api/events");
  source = stream;
  stream.onopen = () => {
    lastSeen = Date.now();
    refusals = 0;
    setConnected(true);
    dispatch({ topic: "open" });
  };
  stream.addEventListener("ping", () => {
    lastSeen = Date.now();
  });
  stream.onmessage = (event: MessageEvent<string>) => {
    lastSeen = Date.now();
    try {
      dispatch(JSON.parse(event.data) as LiveEvent);
    } catch {
      // Not ours.
    }
  };
  stream.onerror = () => {
    setConnected(false);
    // A refused stream (signed out, a proxy that won't stream) is closed for
    // good; try again later rather than never, waiting longer each time.
    if (stream.readyState === EventSource.CLOSED) {
      stream.close();
      if (source === stream) source = null;
      refusals += 1;
      const wait = Math.min(60_000, 2_000 * 2 ** (refusals - 1)) * (0.75 + Math.random() / 2);
      window.setTimeout(() => {
        if (listeners.size > 0) connect();
      }, wait);
    }
  };
}

function disconnect() {
  source?.close();
  source = null;
  setConnected(false);
}

/**
 * Calls `onMessage` for every event while mounted, and returns whether the
 * stream is up right now (so the caller can poll slowly or quickly).
 */
export function useLiveEvents(onMessage: Listener): boolean {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const listener: Listener = (message) => handler.current(message);
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) disconnect();
    };
  }, []);

  return useSyncExternalStore(
    (notify) => {
      connectionListeners.add(notify);
      return () => connectionListeners.delete(notify);
    },
    () => connected,
    () => false,
  );
}

/** How often to poll anyway: rarely while events arrive, as before when they don't. */
export function pollInterval(live: boolean, fallbackMs: number, safetyMs = 30_000) {
  return live ? Math.max(safetyMs, fallbackMs) : fallbackMs;
}
