"use client";

import type { AppCatalogEntry, Bot, Connection, Message } from "@krubot/shared";
import { Check, Plug, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActionCard } from "@/components/action-card";
import { AppIcon, appName } from "@/components/app-icons";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, post } from "@/lib/api";

/**
 * A bot connected one of your apps and you sign in here, rather than on a
 * link in the message: the Connect Link is asked for when you tap, so it
 * can't expire while the card waits, and the card follows the connection
 * live. The sign-in happens on the app's own site; Kru Bot keeps the token
 * and the bots never see it.
 */
export function ConnectCard({ message, bot, toolkit }: { message: Message; bot: Bot | undefined; toolkit: string }) {
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [app, setApp] = useState<AppCatalogEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [apps, connections] = await Promise.all([
      api<{ apps: AppCatalogEntry[] }>("/api/catalog").catch(() => null),
      api<{ connections: Connection[] }>("/api/connections").catch(() => null),
    ]);
    if (apps) setApp(apps.apps.find((a) => a.toolkit === toolkit) ?? null);
    if (connections) setConnection(connections.connections.find((c) => c.toolkit === toolkit) ?? null);
  }, [toolkit]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The sign-in comes back to this conversation, not to Settings.
      const started = await post<{ redirectUrl: string | null }>(`/api/connections/${toolkit}/connect`, { threadId: message.threadId });
      if (started.redirectUrl) {
        setWaiting(true);
        window.location.assign(started.redirectUrl);
        return;
      }
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the connection.");
    } finally {
      setBusy(false);
    }
  }

  const name = app?.name ?? appName(toolkit);
  const connected = connection?.status === "active";

  return (
    <ActionCard icon={<Plug className="size-3.5" aria-hidden="true" />} title={`${bot?.name ?? "A bot"} connects an app`}>
        <p className="flex items-center gap-2 text-[13.5px]">
          <AppIcon toolkit={toolkit} logo={app?.logo} size={20} />
          <span className="font-medium">{name}</span>
        </p>
        {connection === undefined ? (
          <Spinner />
        ) : connected ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Check className="size-3.5 text-mint" aria-hidden="true" />
            Connected. Give it to a bot in its profile to use it.
          </p>
        ) : (
          <>
            {connection?.status === "failed" ? (
              <p className="flex items-start gap-1.5 text-[12.5px] text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                The last sign-in didn&apos;t finish.
              </p>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">Sign in to {name} once, and the bots you give it to can use it.</p>
            )}
            {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
            <div>
              <Button size="sm" disabled={busy || waiting} onClick={() => void connect()}>
                {busy || waiting ? <Spinner data-icon="inline-start" /> : null}
                {waiting ? "Opening the sign-in…" : connection?.status === "pending" ? `Finish connecting ${name}` : `Connect ${name}`}
              </Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground">You sign in on {name}&apos;s own site; Kru Bot keeps the token and the bots never see it.</p>
          </>
        )}
    </ActionCard>
  );
}
