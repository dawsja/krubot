"use client";

import { joinCommandLine, type McpServer } from "@krubot/shared";
import { LogIn, Plug, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useLiveEvents } from "@/components/hq/live-events";
import { McpIcon } from "@/components/app-icons";
import { McpDialog } from "@/components/mcp-dialog";
import { McpPasteSignIn, startMcpSignIn } from "@/components/mcp-signin";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del, patch } from "@/lib/api";
import { toast } from "@/components/ui/toast";

/** Settings → Apps → MCP servers: your own servers, given to bots in their profiles. */
export function McpCard() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  /** A localhost sign-in open in another tab, finished in a dialog here. */
  const [finishing, setFinishing] = useState<McpServer | null>(null);

  async function signIn(server: McpServer) {
    setSigningIn(server.id);
    try {
      if (await startMcpSignIn(server)) {
        setFinishing(server);
        setSigningIn(null);
      }
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not start the sign-in." });
      setSigningIn(null);
      void load();
    }
  }

  const load = useCallback(async () => {
    const data = await api<{ servers: McpServer[] }>("/api/mcp-servers").catch(() => null);
    if (data) setServers(data.servers);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>Your own tool servers. Headers and sign-ins stay in Kru Bot, so the bots never hold them. Give one to a bot in its profile.</CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add server
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!servers ? (
          <Spinner />
        ) : servers.length === 0 ? (
          <Empty className="border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Plug />
              </EmptyMedia>
              <EmptyTitle>No MCP servers</EmptyTitle>
              <EmptyDescription>Add one, then give it to the bots that need its tools.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {servers.map((server) => (
              <li key={server.id} className="group flex items-center gap-3 rounded-xl border px-3 py-2">
                <McpIcon id={server.id} transport={server.transport} size={24} />
                <button type="button" onClick={() => setEditing(server)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13.5px] font-medium">{server.name}</span>
                    <Badge variant="outline">{server.transport === "http" ? "HTTP" : "command"}</Badge>
                    {Object.values(server.headers).some((v) => /\{\{\s*secret:/.test(v)) ? <Badge variant="secondary">uses a secret</Badge> : null}
                    {server.authStatus === "signed_in" ? <Badge variant="secondary">signed in</Badge> : server.authStatus === "needed" ? <Badge variant="destructive">needs sign-in</Badge> : server.authStatus === "error" ? <Badge variant="destructive">sign-in problem</Badge> : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[12px] text-muted-foreground">{server.transport === "http" ? server.url : joinCommandLine([server.command ?? "", ...server.args])}</span>
                  {server.authStatus === "error" && server.authError ? <span className="mt-0.5 block text-[12px] text-destructive">{server.authError}</span> : null}
                </button>
                {server.authStatus === "needed" || server.authStatus === "error" ? (
                  <Button size="xs" disabled={signingIn === server.id} onClick={() => void signIn(server)}>
                    {signingIn === server.id ? <Spinner data-icon="inline-start" /> : <LogIn data-icon="inline-start" aria-hidden="true" />}
                    Sign in
                  </Button>
                ) : server.authStatus === "signed_in" ? (
                  <Button variant="ghost" size="xs" onClick={() => void del(`/api/mcp-servers/${server.id}/login`).then(load)}>
                    Sign out
                  </Button>
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Delete ${server.name}`} onClick={() => setRemoving(server)} className="text-destructive opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100" />}>
                    <Trash2 aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
                <Switch size="sm" checked={server.enabled} onCheckedChange={(on) => void patch(`/api/mcp-servers/${server.id}`, { enabled: on }).then(load)} aria-label={`${server.name} on or off`} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {editing ? <McpDialog server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} /> : null}
      <Dialog open={Boolean(finishing)} onOpenChange={(open) => !open && setFinishing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Finish signing in to {finishing?.name}</DialogTitle>
            <DialogDescription>The sign-in opened in another tab. Sign in there, then come back.</DialogDescription>
          </DialogHeader>
          {finishing ? (
            <McpPasteSignIn
              name={finishing.name}
              onDone={(name) => {
                setFinishing(null);
                toast.add({ type: "success", title: `Signed in to ${name}.` });
                void load();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this server?</AlertDialogTitle>
            <AlertDialogDescription>The bots lose {removing?.name}&apos;s tools on their next reply.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void del(`/api/mcp-servers/${removing.id}`).then(load).finally(() => setRemoving(null))}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
