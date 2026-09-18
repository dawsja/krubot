"use client";

import { APPROVAL_LEVEL_LABELS, type Bot, type McpServer, mcpToolkit, type Routine, type Thread } from "@krubot/shared";
import { Clock, Monitor, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { appName, AppIcon, McpIcon } from "@/components/app-icons";
import { BotAvatar } from "@/components/bot-avatar";
import { useLiveEvents } from "@/components/hq/live-events";
import { RoutineDialog } from "@/components/routine-dialog";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del, patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Cron in words, for the common shapes; the raw expression otherwise. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts as [string, string, string, string, string];
  const time = /^\d+$/.test(hour) && /^\d+$/.test(min) ? `${Number(hour) % 12 || 12}:${min.padStart(2, "0")} ${Number(hour) < 12 ? "AM" : "PM"}` : null;
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (time && dom === "*" && dow === "*") return `Every day at ${time}`;
  if (time && dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return `Weekdays at ${time}`;
  if (time && dom === "*" && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${time}`;
  if (min === "0" && hour === "*") return "Every hour";
  if (/^\*\/\d+$/.test(min) && hour === "*") return `Every ${min.slice(2)} minutes`;
  if (time && /^\d+$/.test(dom) && dow === "*") return `Monthly on the ${dom}${["st", "nd", "rd"][Number(dom) - 1] ?? "th"} at ${time}`;
  return cron;
}

/** Opens the computer: a grey screen with its icon, and a label on hover. */
function ScreenPreview({ bot, working }: { bot: Bot; working: boolean }) {
  return (
    <button type="button" onClick={() => openShellDialog({ kind: "computer", botId: bot.id })} className="group relative block w-full overflow-hidden rounded-xl border bg-muted text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={`Open ${bot.name}'s computer`}>
      <div className="flex aspect-[16/10] w-full items-center justify-center text-muted-foreground">
        <Monitor className="size-8" aria-hidden="true" />
        {working ? <span className="absolute top-2 right-2 size-2 animate-pulse rounded-full bg-mint" aria-hidden="true" /> : null}
      </div>
      <span className="absolute inset-x-0 bottom-0 bg-black/40 px-3 py-1.5 text-[12px] text-white/90 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100">Open the desktop</span>
    </button>
  );
}

function RoutineRow({ routine, onEdit, onChange }: { routine: Routine; onEdit: () => void; onChange: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="group flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-card">
      <Clock className={cn("mt-0.5 size-3.5 shrink-0", routine.enabled ? "text-muted-foreground" : "text-ash")} aria-hidden="true" />
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
        <span className={cn("block truncate text-[13px] font-medium", !routine.enabled && "text-muted-foreground")}>{routine.name}</span>
        <span className="block text-[12px] text-muted-foreground">{routine.enabled ? describeCron(routine.cron) : "Paused"}</span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="xs" onClick={() => void post(`/api/routines/${routine.id}/run`)} className="opacity-100 group-hover:opacity-100 focus-visible:opacity-100 xwide:opacity-0">
          Run
        </Button>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Delete" onClick={() => setConfirming(true)} className="text-destructive opacity-100 group-hover:opacity-100 focus-visible:opacity-100 xwide:opacity-0" />}>
            <Trash2 aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
        <Switch size="sm" checked={routine.enabled} onCheckedChange={(on) => void patch(`/api/routines/${routine.id}`, { enabled: on }).then(onChange)} aria-label={`${routine.name} on or off`} className="ml-1" />
      </span>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this routine?</AlertDialogTitle>
            <AlertDialogDescription>&ldquo;{routine.name}&rdquo; stops running and is removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void del(`/api/routines/${routine.id}`).then(onChange)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** What the panel shows: the bot's computer, its routines and its profile; a room's members. */
export function RightPanelContent({ thread, bot, working }: { thread: Thread; bot: Bot | null; working: boolean }) {
  const { bots, admin } = useStore();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const usesMcp = Boolean(bot?.toolkits.some((t) => t.startsWith(mcpToolkit(""))));

  const load = useCallback(async () => {
    if (!bot) return;
    const data = await api<{ routines: Routine[] }>(`/api/routines?bot=${bot.id}`).catch(() => null);
    if (data) setRoutines(data.routines);
  }, [bot]);

  // The bot's own MCP servers show by name, as in its profile.
  useEffect(() => {
    if (!usesMcp) return;
    void api<{ servers: McpServer[] }>("/api/mcp-servers")
      .then((d) => setServers(d.servers))
      .catch(() => undefined);
  }, [usesMcp, bot?.toolkits]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  if (!bot) {
    const members = thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));
    return (
      <>
        <section>
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">In this room</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {members.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-[13px]">
                <BotAvatar bot={b} size={24} />
                <span className="font-medium">{b.name}</span>
                <span className="truncate text-muted-foreground">{b.title}</span>
                {b.isChief ? <Badge variant="secondary">Chief</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  }

  return (
    <>
      {admin ? (
        <section>
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{bot.name}&apos;s computer</h2>
          <div className="mt-2">
            <ScreenPreview bot={bot} working={working} />
          </div>
        </section>
      ) : null}

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Routines</h2>
          <Button variant="ghost" size="icon-xs" aria-label="New routine" onClick={() => setEditing("new")}>
            <Plus aria-hidden="true" />
          </Button>
        </div>
        {routines.length === 0 ? (
          <Empty className="mt-2 border px-3 py-5">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock />
              </EmptyMedia>
              <EmptyTitle>Nothing scheduled</EmptyTitle>
              <EmptyDescription className="text-xs">A routine runs a prompt for {bot.name} on a schedule, like a morning briefing.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {routines.map((r) => (
              <RoutineRow key={r.id} routine={r} onEdit={() => setEditing(r)} onChange={load} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Profile</h2>
        <dl className="mt-2 flex flex-col gap-1.5 text-[12.5px]">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Approvals</dt>
            <dd>{APPROVAL_LEVEL_LABELS[bot.approval].title}</dd>
          </div>
          {bot.isChief ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Role</dt>
              <dd>Chief of Staff</dd>
            </div>
          ) : null}
        </dl>
        {bot.toolkits.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {bot.toolkits.map((t) => {
              const server = servers.find((s) => mcpToolkit(s.id) === t);
              // A server that isn't in your list any more (removed) has nothing to show.
              if (!server && t.startsWith(mcpToolkit(""))) return null;
              return (
                <Badge key={t} variant="outline" className="gap-1">
                  {server ? <McpIcon id={server.id} transport={server.transport} size={12} /> : <AppIcon toolkit={t} size={12} />}
                  {server ? server.name : appName(t)}
                </Badge>
              );
            })}
          </div>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => openShellDialog({ kind: "edit-bot", botId: bot.id })} className="mt-3 w-full">
          Edit profile
        </Button>
      </section>

      {editing ? <RoutineDialog bot={bot} routine={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} /> : null}
    </>
  );
}

/** The panel on the right of a conversation, on wide screens. */
export function RightPanel(props: { thread: Thread; bot: Bot | null; working: boolean }) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l bg-background p-4 xwide:flex">
      <RightPanelContent {...props} />
    </aside>
  );
}

/** The same, as a sheet from the bottom on phones and narrow windows. */
export function DetailsSheet({ open, onOpenChange, ...props }: { open: boolean; onOpenChange: (open: boolean) => void; thread: Thread; bot: Bot | null; working: boolean }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)] xwide:hidden">
        <SheetHeader className="pb-2">
          <SheetTitle>{props.bot ? props.bot.name : props.thread.name}</SheetTitle>
          <SheetDescription>{props.bot ? props.bot.title || "Teammate" : `${props.thread.members.length} bots`}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">{open ? <RightPanelContent {...props} /> : null}</div>
      </SheetContent>
    </Sheet>
  );
}
