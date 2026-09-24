"use client";

import { composioCardToolkit, type Bot, type McpServer, type Message } from "@krubot/shared";
import { Check, LogIn, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActionCard } from "@/components/action-card";
import { ConnectCard } from "@/components/connect-card";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { McpPasteSignIn, startMcpSignIn } from "@/components/mcp-signin";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

/**
 * A bot added an MCP server that wants the person signed in. The button
 * runs the server's OAuth sign-in and comes back to this conversation; the
 * card follows the server's sign-in state live. A card for a connected app
 * (`composio:<toolkit>`) is the same idea, drawn by ConnectCard.
 */
export function SignInCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const toolkit = composioCardToolkit(message.approvalId);
  if (toolkit) return <ConnectCard message={message} bot={bot} toolkit={toolkit} />;
  return <McpSignInCard message={message} bot={bot} />;
}

function McpSignInCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const id = message.approvalId;
  const [server, setServer] = useState<McpServer | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A localhost sign-in is open in another tab and finishes here. */
  const [waiting, setWaiting] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ servers: McpServer[] }>("/api/mcp-servers").catch(() => null);
    if (data) setServer(data.servers.find((s) => s.id === id) ?? null);
  }, [id]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function signIn() {
    if (!server || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await startMcpSignIn(server, message.threadId)) {
        setWaiting(true);
        setBusy(false);
      }
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not start the sign-in.");
      void load();
    }
  }

  const name = server?.name ?? message.body.replace(/^Sign in to /, "");
  let host = "";
  try {
    host = server?.url ? new URL(server.url).host : "";
  } catch {
    /* not a URL */
  }

  return (
    <ActionCard icon={<LogIn className="size-3.5" aria-hidden="true" />} title={`${bot?.name ?? "A bot"} connected an app`}>
        <p className="text-[13.5px]">
          <span className="font-medium">{name}</span>
          {host ? <span className="text-muted-foreground"> · {host}</span> : null}
        </p>
        {server === undefined ? (
          <Spinner />
        ) : server === null ? (
          <p className="text-[12px] text-muted-foreground">This server was removed.</p>
        ) : server.authStatus === "signed_in" ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Check className="size-3.5 text-mint" aria-hidden="true" />
            Signed in.
          </p>
        ) : server.authStatus === "none" ? (
          <p className="text-[12.5px] text-muted-foreground">Connected. It didn&apos;t need a sign-in.</p>
        ) : (
          <>
            {server.authStatus === "error" && server.authError ? (
              <p className="flex items-start gap-1.5 text-[12.5px] text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {server.authError}
              </p>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">It needs you to sign in before the bots can use it.</p>
            )}
            {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
            <div>
              <Button size="sm" variant={waiting ? "outline" : "default"} disabled={busy || !server.enabled} onClick={() => void signIn()}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {waiting ? "Open the sign-in again" : server.authStatus === "error" ? "Try again" : `Sign in to ${name}`}
              </Button>
            </div>
            {waiting ? <McpPasteSignIn name={name} onDone={() => void load()} /> : null}
            <p className="text-[11.5px] text-muted-foreground">You sign in on {host || "the app's site"}; Kru Bot keeps the token and the bots never see it.</p>
          </>
        )}
    </ActionCard>
  );
}
