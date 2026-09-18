"use client";

import type { Approval, Bot, BoxUpdate, Me, Thread } from "@krubot/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { api } from "@/lib/api";

/*
 * What every page of the app shares: the bots, the conversations (with
 * their previews and unread counts), the open approvals, and the bots'
 * live activity lines. Fetched once, refreshed when /api/events says
 * something changed, and on a slow poll as a safety net.
 */

export type ThreadRow = Thread & { busy?: boolean };

export type { Me };

type Store = {
  bots: Bot[];
  threads: ThreadRow[];
  approvals: Approval[];
  /** The line each bot is on right now, by thread then bot. */
  activity: Record<string, Record<string, string>>;
  /** You: name, role and picture, as shown in the sidebar and on your messages. */
  me: Me;
  setMe: (me: Me) => void;
  /** Whether you are the admin: the settings beyond your account, and the computer. */
  admin: boolean;
  /** The computer's update, when one is running or just finished. */
  boxUpdate: BoxUpdate | null;
  boxUpdating: boolean;
  loaded: boolean;
  live: boolean;
  refresh: () => Promise<void>;
  botById: (id: string) => Bot | undefined;
};

const StoreContext = createContext<Store | null>(null);
const POLL_MS = 15_000;

const UPDATING = new Set(["pausing", "pulling", "restarting", "patching", "resuming"]);

export function StoreProvider({ user, children }: { user: Me; children: ReactNode }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<Record<string, Record<string, string>>>({});
  const [me, setMe] = useState<Me>(user);
  const [boxUpdate, setBoxUpdate] = useState<BoxUpdate | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadMe = useCallback(async () => {
    const data = await api<{ user: Me }>("/api/me");
    setMe(data.user);
  }, []);
  const loadBoxUpdate = useCallback(async () => {
    const data = await api<{ update: BoxUpdate }>("/api/box/update");
    setBoxUpdate(data.update.phase === "idle" ? null : data.update);
  }, []);

  const loadBots = useCallback(async () => {
    const [b, t] = await Promise.all([api<{ bots: Bot[] }>("/api/bots"), api<{ threads: ThreadRow[] }>("/api/threads")]);
    setBots(b.bots);
    setThreads(t.threads);
  }, []);
  const loadApprovals = useCallback(async () => {
    const a = await api<{ approvals: Approval[] }>("/api/approvals?status=pending");
    setApprovals(a.approvals);
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([loadBots(), loadApprovals(), loadBoxUpdate().catch(() => undefined)]).catch(() => undefined);
    setLoaded(true);
  }, [loadBots, loadApprovals, loadBoxUpdate]);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    // Off the effect's own tick: the fetches settle later and set state then.
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const live = useLiveEvents((message) => {
    if (message.topic === "open") void refreshRef.current();
    else if (message.topic === "bots" || message.topic === "thread") void loadBots().catch(() => undefined);
    else if (message.topic === "approvals") void loadApprovals().catch(() => undefined);
    else if (message.topic === "me") void loadMe().catch(() => undefined);
    else if (message.topic === "box") void loadBoxUpdate().catch(() => undefined);
    else if (message.topic === "activity") {
      setActivity((current) => {
        const forThread = { ...(current[message.threadId] ?? {}) };
        if (message.line === null) delete forThread[message.botId];
        else forThread[message.botId] = message.line;
        return { ...current, [message.threadId]: forThread };
      });
    }
  });

  useEffect(() => {
    const timer = window.setInterval(() => void refreshRef.current(), pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [live]);

  const value = useMemo<Store>(
    () => ({ bots, threads, approvals, activity, me, setMe, admin: me.role === "admin", boxUpdate, boxUpdating: Boolean(boxUpdate && UPDATING.has(boxUpdate.phase)), loaded, live, refresh, botById: (id) => bots.find((b) => b.id === id) }),
    [bots, threads, approvals, activity, me, boxUpdate, loaded, live, refresh],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore needs StoreProvider");
  return store;
}
