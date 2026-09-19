"use client";

import { handleOf, type Bot, type Message } from "@krubot/shared";
import { MessageSquareText, Pin, Plus, Search, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BotAvatar, PersonAvatar } from "@/components/bot-avatar";
import { KruBot } from "@/components/hq/kru-bot";
import { ProfileMenu } from "@/components/profile-menu";
import type { ShellDialog } from "@/components/shell";
import { useStore, type ThreadRow } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, useSidebar } from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** "9:41 AM" today, "Tuesday" this week, "Sep 3" otherwise. */
export function shortTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function preview(thread: ThreadRow, bots: Bot[], activity: Record<string, string>): string {
  const busyBot = Object.keys(activity)[0];
  if (busyBot) {
    const line = activity[busyBot]!;
    const name = bots.find((b) => b.id === busyBot)?.name;
    return thread.kind === "room" && name ? `${name}: ${line}` : line;
  }
  const last = thread.lastMessage;
  if (!last) return thread.kind === "room" ? "A room for several bots." : "Say hello, or hand over a task.";
  const who = last.author === "you" ? "You: " : thread.kind === "room" ? `${bots.find((b) => b.id === last.author)?.name ?? ""}: ` : "";
  return `${who}${last.body.replace(/\s+/g, " ")}`;
}

/**
 * One conversation in the list. Everything you can do to a bot (edit, pin,
 * open its computer, duplicate, clear, delete) is on its right-click menu,
 * a long press on a phone; a room gets clear and delete.
 */
function Row({ thread, bot, active, bots, activity, onOpen, onAsk }: { thread: ThreadRow; bot: Bot | undefined; active: boolean; bots: Bot[]; activity: Record<string, string>; onOpen: (dialog: ShellDialog) => void; onAsk: (ask: Ask) => void }) {
  const { setOpenMobile } = useSidebar();
  const { refresh, admin } = useStore();
  const working = Object.keys(activity).length > 0;
  const groups = threadActions({ thread, bot, admin, onOpen, onAsk, refresh });
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<SidebarMenuItem />}>
        <SidebarMenuButton size="lg" isActive={active} render={<Link href={`/app/t/${thread.id}`} aria-current={active ? "page" : undefined} onClick={() => setOpenMobile(false)} />} className="h-16 gap-3 rounded-xl px-2.5 data-active:bg-card data-active:shadow-subtle hover:bg-card/60 wide:h-14">
          {bot ? (
            <BotAvatar bot={bot} size={40} />
          ) : (
            <Avatar size="lg">
              <AvatarFallback>
                <Users className="size-5" aria-hidden="true" />
              </AvatarFallback>
            </Avatar>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[15px] font-semibold wide:text-[14px]">{thread.name || bot?.name || "Room"}</span>
                {bot?.title && thread.kind !== "room" ? (
                  <Badge variant="secondary" className="h-4 max-w-[55%] min-w-0 shrink px-1.5 text-[10.5px] font-normal text-muted-foreground" title={bot.title}>
                    <span className="truncate">{bot.title}</span>
                  </Badge>
                ) : null}
                {bot?.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" /> : null}
              </span>
              {thread.lastMessage ? <span className="shrink-0 text-[11px] text-ash">{shortTime(thread.lastMessage.at)}</span> : null}
            </span>
            <span className={cn("flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground wide:text-[12.5px]", working && "italic")}>
              <span className="truncate">{preview(thread, bots, activity)}</span>
              {thread.unread > 0 && !active ? <span className="ml-auto size-2 shrink-0 rounded-full" style={{ background: bot?.color ?? "var(--brand)" }} aria-label={`${thread.unread} unread`} /> : null}
            </span>
          </span>
        </SidebarMenuButton>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {groups.map((group, i) => (
          <ContextMenuGroup key={i} className={cn(i > 0 && "border-t pt-1 mt-1")}>
            {group.map((action) => (
              <ContextMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onClick={action.run}>
                <action.icon aria-hidden="true" />
                {action.label}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The search box above the list; two or more characters also search what was said. */
export function useBotSearch() {
  const { bots, threads } = useStore();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; messages: Message[] }>({ q: "", messages: [] });
  const hits = found.q === query.trim() ? found.messages : [];
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(q)}`)
        .then((d) => alive && setFound({ q, messages: d.messages.slice(0, 12) }))
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byId = new Map(bots.map((b) => [b.id, b]));
    return threads
      .filter((t) => !t.botId || byId.has(t.botId))
      .filter((t) => {
        if (!q) return true;
        const bot = t.botId ? byId.get(t.botId) : undefined;
        return t.name.toLowerCase().includes(q) || Boolean(bot && (bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q) || handleOf(bot.name).includes(q)));
      })
      .sort((a, b) => {
        const pa = a.botId ? Number(byId.get(a.botId)?.pinned) : 0;
        const pb = b.botId ? Number(byId.get(b.botId)?.pinned) : 0;
        if (pa !== pb) return pb - pa;
        return (b.lastMessage?.at ?? b.updatedAt).localeCompare(a.lastMessage?.at ?? a.updatedAt);
      });
  }, [threads, bots, query]);

  return { query, setQuery, rows, hits };
}

export function BotSearchInput({ query, setQuery, autoFocus = false, className }: { query: string; setQuery: (q: string) => void; autoFocus?: boolean; className?: string }) {
  return (
    <InputGroup className={cn("h-9 flex-1 rounded-full bg-muted border-transparent", className)}>
      <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search bots" autoFocus={autoFocus} className="text-[13px]" />
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
    </InputGroup>
  );
}

/** The + menu: a bot, or a group chat. */
export function NewMenu({ onOpen, size = "icon-lg" }: { onOpen: (dialog: ShellDialog) => void; size?: "icon-xl" | "icon-lg" | "icon" }) {
  const { bots } = useStore();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size={size} aria-label="New" />}>
        <Plus aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onOpen({ kind: "new-bot" })}>Create a bot</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpen({ kind: "new-room" })} disabled={bots.length === 0}>
            New group chat
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The approvals waiting, as a link to the first; nothing when there are none. */
export function ApprovalsBadge({ className }: { className?: string }) {
  const { approvals } = useStore();
  if (approvals.length === 0) return null;
  return (
    <Badge variant="secondary" render={<Link href={`/app/t/${approvals[0]!.threadId}`} />} className={cn("h-9 w-full justify-start gap-2 rounded-xl bg-amber/15 px-3 text-[13px] text-foreground hover:bg-amber/25 wide:h-8 wide:text-[12.5px]", className)}>
      <span className="size-2 rounded-full bg-amber" aria-hidden="true" />
      {approvals.length === 1 ? "1 approval waiting" : `${approvals.length} approvals waiting`}
    </Badge>
  );
}

/**
 * The conversations, with the messages that match a search under them.
 * The sidebar on a desktop and the Chats screen on a phone both show it.
 */
export function BotRows({ rows, hits, query, setQuery, onOpen, onAsk }: { rows: ThreadRow[]; hits: Message[]; query: string; setQuery: (q: string) => void; onOpen: (dialog: ShellDialog) => void; onAsk: (ask: Ask) => void }): ReactNode {
  const { bots, threads, activity, loaded } = useStore();
  const pathname = usePathname();
  return (
    <>
      {!loaded ? (
        <SidebarMenu className="gap-1">
          {Array.from({ length: 4 }, (_, i) => (
            <SidebarMenuSkeleton key={i} showIcon className="h-14 rounded-xl" />
          ))}
        </SidebarMenu>
      ) : rows.length === 0 && query.trim() ? (
        hits.length ? null : <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">Nothing matches.</p>
      ) : rows.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyMedia>
              <KruBot color="#1DB954" size={56} expression="sleepy" greet={false} />
            </EmptyMedia>
            <EmptyTitle>No bots yet</EmptyTitle>
            <EmptyDescription>Create one and give it a job.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => onOpen({ kind: "new-bot" })}>Create your first bot</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <SidebarMenu className="gap-0.5" aria-label="Bots">
          {rows.map((thread) => (
            <Row key={thread.id} thread={thread} bot={thread.botId ? bots.find((b) => b.id === thread.botId) : undefined} active={pathname === `/app/t/${thread.id}`} bots={bots} activity={activity[thread.id] ?? {}} onOpen={onOpen} onAsk={onAsk} />
          ))}
        </SidebarMenu>
      )}
      {hits.length ? (
        <div className="mt-3">
          <h3 className="px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">In messages</h3>
          <SidebarMenu className="mt-1 gap-0.5" aria-label="Messages that match">
            {hits.map((hit) => {
              const thread = threads.find((t) => t.id === hit.threadId);
              const who = hit.author === "you" ? "You" : (bots.find((b) => b.id === hit.author)?.name ?? thread?.name ?? "Bot");
              return (
                <SidebarMenuItem key={hit.id}>
                  <SidebarMenuButton size="lg" render={<Link href={`/app/t/${hit.threadId}?m=${hit.id}`} onClick={() => setQuery("")} />} className="h-12 items-start gap-2.5 rounded-xl px-2.5 hover:bg-card/60">
                    <MessageSquareText className="mt-1 text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12.5px] font-medium">
                        {who}
                        {thread && thread.kind === "room" ? ` in ${thread.name}` : ""}
                        <span className="ml-1.5 font-normal text-ash">{shortTime(hit.createdAt)}</span>
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">{hit.body.replace(/\s+/g, " ")}</span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </div>
      ) : null}
    </>
  );
}

/** The bot list on a desktop: search, the conversations, and you at the bottom. */
export function AppSidebar({ onOpen }: { onOpen: (dialog: ShellDialog) => void }) {
  const { me } = useStore();
  const pathname = usePathname();
  const [ask, setAsk] = useState<Ask | null>(null);
  const { query, setQuery, rows, hits } = useBotSearch();

  return (
    <Sidebar collapsible="offcanvas" className="bg-background [&_[data-sidebar=sidebar]]:bg-background">
      <SidebarHeader className="flex-row items-center gap-2 px-3 pt-3 pb-2">
        <BotSearchInput query={query} setQuery={setQuery} />
        <NewMenu onOpen={onOpen} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="py-0 empty:hidden">
          <ApprovalsBadge />
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupContent>
            <BotRows rows={rows} hits={hits} query={query} setQuery={setQuery} onOpen={onOpen} onAsk={setAsk} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu className="gap-0.5">
          {/* You, bottom left: a menu with Settings and Sign out. */}
          <SidebarMenuItem>
            <ProfileMenu trigger={<SidebarMenuButton isActive={pathname.startsWith("/app/settings")} aria-label="Your menu" className="h-10 gap-3 rounded-xl px-2.5 text-[13.5px] font-medium data-active:bg-card data-active:shadow-subtle hover:bg-card/60" />}>
              <PersonAvatar name={me.name} avatar={me.avatar} size={24} />
              <span className="truncate">{me.name}</span>
            </ProfileMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
    </Sidebar>
  );
}
