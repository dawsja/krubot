"use client";

import { handleOf, type Approval, type Bot, type Message, type Thread } from "@krubot/shared";
import { Bot as BotIcon, ChevronLeft, Clock, Download, EllipsisVertical, FileText, PanelRight, Paperclip, Plus, SendHorizonal, Square, Users, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { BotAvatar, YouAvatar } from "@/components/bot-avatar";
import { ExchangeDialog } from "@/components/exchange-dialog";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { Markdown } from "@/components/markdown";
import { DetailsSheet, RightPanel } from "@/components/right-panel";
import { SecretCard } from "@/components/secret-card";
import { openShellDialog } from "@/components/shell";
import { SignInCard } from "@/components/signin-card";
import { matchBots, matchSkills, SlashMenu, slashQuery, useSkillsLibrary } from "@/components/slash-menu";
import { shortTime } from "@/components/sidebar";
import { useStore, type ThreadRow } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message as MessageRow, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from "@/components/ui/message-scroller";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCoarsePointer } from "@/hooks/use-mobile";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { api, post } from "@/lib/api";
import { cn } from "@/lib/utils";

/*
 * One conversation: a bot's 1:1 or a room. Messages are fetched once, then
 * only what's new when /api/events says the thread changed (and on a slow
 * poll while the stream is down). The thread itself is the shadcn message
 * scroller, so following new replies and jumping back to the latest are
 * built in. The right panel shows the bot's screen and its routines.
 *
 * What a bot sends to a teammate (a brief, a question, a note) is one
 * short line here, "Messaged X" or "Message from X", not a bubble; the
 * line opens the two bots' exchange, read-only. Editing, pinning and
 * deleting live on the bot's right-click menu in the sidebar.
 */

const POLL_MS = 4_000;
const MAX_FILES = 6;

type ThreadInfo = { thread: Thread; bot: Bot | null; busy: string[] };
type Decision = "allow" | "deny" | "always";

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ApprovalCard({ message, approval, bot, onDecide }: { message: Message; approval: Approval | null; bot: Bot | undefined; onDecide: (id: string, decision: Decision) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const status = approval?.status ?? "pending";
  const decide = async (decision: Decision) => {
    if (!message.approvalId || busy) return;
    setBusy(true);
    try {
      await onDecide(message.approvalId, decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Bubble variant="outline" className="max-w-[80%]">
      <BubbleContent className="flex flex-col gap-2 border-amber/40 bg-amber/10 p-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{bot?.name ?? "A bot"} asks to</p>
        <p className="font-mono text-[12.5px] leading-5 break-words">{message.body}</p>
        {status === "pending" ? (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide("allow")}>
              Allow once
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide("always")}>
              Always allow
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">{status === "allowed" ? (approval?.rule ? `Allowed, and always from now on (${approval.rule}).` : "Allowed.") : status === "denied" ? "Denied." : "Nobody answered in time."}</p>
        )}
      </BubbleContent>
    </Bubble>
  );
}

/**
 * A bot-to-bot message, in one line: sent from here ("Messaged X") or
 * posted here by a teammate ("Message from X"). Opens their exchange.
 */
function Handoff({ message, threadId, bots, threads, onOpen }: { message: Message; threadId: string; bots: Bot[]; threads: ThreadRow[]; onOpen: (withThreadId: string) => void }) {
  const incoming = message.threadId === threadId;
  const otherId = incoming ? message.fromThreadId! : message.threadId;
  const other = threads.find((t) => t.id === otherId);
  const party = incoming ? bots.find((b) => b.id === message.author) : other?.botId ? bots.find((b) => b.id === other.botId) : undefined;
  return (
    <Marker className="justify-center">
      <button
        type="button"
        onClick={() => onOpen(otherId)}
        title={message.body.replace(/\s+/g, " ").slice(0, 200)}
        className="flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span>{incoming ? "Message from" : "Messaged"}</span>
        {party ? <BotAvatar bot={party} size={16} /> : <Users className="size-3.5" aria-hidden="true" />}
        <span className="truncate font-medium">{party?.name ?? other?.name ?? "a teammate"}</span>
      </button>
    </Marker>
  );
}

function Line({ message, threadId, bots, threads, bot, approvals, isRoom, onDecide, onOpenExchange }: { message: Message; threadId: string; bots: Bot[]; threads: ThreadRow[]; bot: Bot | null; approvals: Map<string, Approval>; isRoom: boolean; onDecide: (id: string, decision: Decision) => Promise<void>; onOpenExchange: (withThreadId: string) => void }) {
  const mine = message.author === "you";
  const author = mine ? null : bots.find((b) => b.id === message.author) ?? null;
  if (message.kind === "prompt") return null;
  if (message.kind === "message" && message.fromThreadId && author) return <Handoff message={message} threadId={threadId} bots={bots} threads={threads} onOpen={onOpenExchange} />;
  if (message.kind === "event") {
    return (
      <Marker className="justify-center">
        <MarkerContent className="max-w-[80%] text-center text-xs">{message.body}</MarkerContent>
      </Marker>
    );
  }
  const avatar = mine ? (
    <YouAvatar size={28} />
  ) : author ? (
    <BotAvatar bot={author} size={28} />
  ) : (
    <Avatar className="size-7 after:hidden">
      <AvatarFallback className="text-muted-foreground">{message.author === "routine" ? <Clock className="size-3.5" /> : <BotIcon className="size-3.5" />}</AvatarFallback>
    </Avatar>
  );
  if (message.kind === "approval" || message.kind === "secret" || message.kind === "signin") {
    return (
      <MessageRow align="start">
        <MessageAvatar className="bg-transparent">{avatar}</MessageAvatar>
        <MessageContent>
          {message.kind === "signin" ? <SignInCard message={message} bot={author ?? bot ?? undefined} /> : message.kind === "secret" ? <SecretCard message={message} bot={author ?? bot ?? undefined} /> : <ApprovalCard message={message} approval={message.approvalId ? approvals.get(message.approvalId) ?? null : null} bot={author ?? bot ?? undefined} onDecide={onDecide} />}
        </MessageContent>
      </MessageRow>
    );
  }
  const showName = !mine && (isRoom || message.author === "routine" || message.author === "system");
  return (
    <MessageRow align={mine ? "end" : "start"}>
      <MessageAvatar className="bg-transparent">{avatar}</MessageAvatar>
      <MessageContent className="gap-1">
        {showName ? <MessageHeader>{author?.name ?? (message.author === "routine" ? "Routine" : "Kru Bot")}</MessageHeader> : null}
        <Bubble variant={mine ? "default" : "outline"} align={mine ? "end" : "start"} className="max-w-[86%] sm:max-w-[78%]">
          <BubbleContent className="rounded-2xl px-3.5 py-2">
            {message.body ? <Markdown text={message.body} className={cn("flex flex-col gap-2 text-[14px] leading-6", mine && "[&_code]:bg-foreground/10 [&_code]:text-foreground")} /> : null}
            {message.attachments.length ? (
              <AttachmentGroup className={cn(message.body && "mt-2")}>
                {message.attachments.map((file) =>
                  file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml" ? (
                    <div key={file.id} className="relative shrink-0">
                      <a href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/attachments/${file.id}`} alt={file.name} className="max-h-60 rounded-lg" />
                      </a>
                      <AttachmentAction variant="secondary" className="absolute top-2 right-2" aria-label={`Download ${file.name}`} render={<a href={`/api/attachments/${file.id}?download`} download={file.name} />} nativeButton={false}>
                        <Download />
                      </AttachmentAction>
                    </div>
                  ) : (
                    <Attachment key={file.id} size="sm">
                      <AttachmentTrigger render={<a href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`} />} />
                      <AttachmentMedia variant="icon">
                        <FileText />
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle>{file.name}</AttachmentTitle>
                        <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                      </AttachmentContent>
                      <AttachmentActions>
                        <AttachmentAction aria-label={`Download ${file.name}`} render={<a href={`/api/attachments/${file.id}?download`} download={file.name} />} nativeButton={false}>
                          <Download />
                        </AttachmentAction>
                      </AttachmentActions>
                    </Attachment>
                  ),
                )}
              </AttachmentGroup>
            ) : null}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="text-[10.5px] font-normal text-ash">{shortTime(message.createdAt)}</MessageFooter>
      </MessageContent>
    </MessageRow>
  );
}

/** Scrolls to the message a search result linked to, once it's on the page. */
function JumpToMessage({ id, ready }: { id: string | null; ready: boolean }) {
  const { scrollToMessage } = useMessageScroller();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !ready || done === id) return;
    const timer = window.setTimeout(() => {
      if (scrollToMessage(id, { align: "center" })) setDone(id);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [id, ready, done, scrollToMessage]);
  return null;
}

export function Conversation({ threadId }: { threadId: string }) {
  const { bots, threads, approvals, activity, refresh, boxUpdating, admin } = useStore();
  const [info, setInfo] = useState<ThreadInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState(true);
  const [details, setDetails] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  // A touch keyboard's Enter makes a new line; the send button sends.
  const touch = useCoarsePointer();
  const params = useSearchParams();
  const jumpTo = params.get("m");
  const skills = useSkillsLibrary();
  const [slash, setSlash] = useState<{ kind: "skill" | "bot"; query: string; start: number; selected: number } | null>(null);
  const [exchange, setExchange] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Map<string, Approval>>(new Map());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<string | null>(null);

  const approvalMap = useMemo(() => {
    const map = new Map(resolved);
    for (const a of approvals) map.set(a.id, a);
    return map;
  }, [approvals, resolved]);

  const append = useCallback((incoming: Message[]) => {
    if (!incoming.length) return;
    setMessages((current) => {
      const seen = new Set(current.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      const next = fresh.length ? [...current, ...fresh] : current;
      cursor.current = next.at(-1)?.createdAt ?? cursor.current;
      return next;
    });
  }, []);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api<ThreadInfo>(`/api/threads/${threadId}`));
    } catch {
      setMissing(true);
    }
  }, [threadId]);

  const loadMessages = useCallback(
    async (after: string | null) => {
      const data = await api<{ messages: Message[] }>(`/api/threads/${threadId}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`).catch(() => null);
      if (!data) return;
      if (!after) {
        setMessages(data.messages);
        cursor.current = data.messages.at(-1)?.createdAt ?? null;
      } else append(data.messages);
      // Resolved approvals are no longer in the pending list; keep their last state.
      const ids = data.messages.filter((m) => m.kind === "approval" && m.approvalId).map((m) => m.approvalId!);
      for (const id of ids) {
        if (approvalMap.has(id)) continue;
        void api<{ approval: Approval }>(`/api/approvals/${id}`)
          .then((d) => setResolved((current) => new Map(current).set(id, d.approval)))
          .catch(() => undefined);
      }
    },
    // approvalMap changes often; the lookups it feeds are best-effort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, append],
  );

  // The page keys this component by thread id, so state starts fresh per
  // conversation; only the loads happen here, off the effect's own tick.
  // A swipe in from the left edge goes back to Chats on a phone.
  useSwipeBack("/app");
  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadInfo();
      void loadMessages(null);
      void post(`/api/threads/${threadId}/read`).catch(() => undefined);
    });
  }, [threadId, loadInfo, loadMessages]);

  const live = useLiveEvents((event) => {
    if (event.topic === "open") {
      void loadMessages(cursor.current);
      void loadInfo();
    } else if (event.topic === "thread" && event.threadId === threadId) {
      // A clear removes what is on screen, so load from the top again.
      void loadMessages(event.cleared ? null : cursor.current);
      void post(`/api/threads/${threadId}/read`).catch(() => undefined);
    } else if (event.topic === "approvals") {
      void loadMessages(cursor.current);
      for (const [id] of approvalMap) {
        void api<{ approval: Approval }>(`/api/approvals/${id}`)
          .then((d) => setResolved((current) => new Map(current).set(id, d.approval)))
          .catch(() => undefined);
      }
    } else if (event.topic === "bots") void loadInfo();
  });

  useEffect(() => {
    const timer = window.setInterval(() => void loadMessages(cursor.current), pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [live, loadMessages]);

  const working = activity[threadId] ?? {};
  const isRoom = info?.thread.kind === "room";
  const bot = info?.bot ?? null;

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    setNotice(null);
    try {
      let body: BodyInit = JSON.stringify({ body: text });
      if (files.length) {
        const form = new FormData();
        form.set("body", text);
        for (const file of files) form.append("files", file, file.name);
        body = form;
      }
      const data = await api<{ message: Message }>(`/api/threads/${threadId}/messages`, { method: "POST", body });
      append([data.message]);
      setDraft("");
      setFiles([]);
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "Could not send.");
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  async function decide(id: string, decision: Decision) {
    const data = await post<{ approval: Approval }>(`/api/approvals/${id}`, { decision });
    setResolved((current) => new Map(current).set(id, data.approval));
    await refresh();
  }

  function attach(added: File[]) {
    if (!added.length) return;
    if (files.length + added.length > MAX_FILES) {
      setNotice(`At most ${MAX_FILES} files per message.`);
      return;
    }
    setFiles([...files, ...added]);
  }

  /** Puts /slug or @handle in the draft where the trigger was typed. */
  function insertToken(token: string) {
    if (!slash) return;
    const el = textarea.current;
    const caret = el?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, slash.start)}${token} ${draft.slice(caret)}`;
    setDraft(next);
    setSlash(null);
    window.requestAnimationFrame(() => {
      const at = slash.start + token.length + 1;
      el?.setSelectionRange(at, at);
      el?.focus();
    });
  }
  const insertSkill = (slug: string) => insertToken(`/${slug}`);
  const insertBot = (b: Bot) => insertToken(`@${handleOf(b.name)}`);

  function trackSlash(text: string, caret: number) {
    const found = slashQuery(text, caret);
    setSlash(found ? { ...found, selected: 0 } : null);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slash) {
      const count = slash.kind === "skill" ? matchSkills(skills, slash.query).length : matchBots(bots, slash.query).length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (count) setSlash({ ...slash, selected: (slash.selected + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && count && !event.shiftKey) {
        event.preventDefault();
        if (slash.kind === "skill") insertSkill(matchSkills(skills, slash.query)[slash.selected]!.slug);
        else insertBot(matchBots(bots, slash.query)[slash.selected]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...event.clipboardData.files];
    if (pasted.length) {
      event.preventDefault();
      attach(pasted);
    }
  }
  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    attach([...event.dataTransfer.files]);
  }

  const mention = (b: Bot) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${handleOf(b.name)} `);
    textarea.current?.focus();
  };

  if (missing) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>That conversation is gone.</EmptyTitle>
          <EmptyDescription>Pick another bot from the list.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const busy = Object.keys(working).length > 0;
  const members = isRoom && info ? info.thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)) : [];
  const row = threads.find((t) => t.id === threadId);
  const actions = row ? threadActions({ thread: row, bot: bot ?? undefined, admin, onOpen: openShellDialog, onAsk: setAsk, refresh }) : [];

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Floating pills on the page, no bar: back, the bot (tap for its details), and its actions. */}
        <header className="flex h-[calc(64px+env(safe-area-inset-top))] shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)] sm:px-4">
          <Button size="icon-xl" aria-label="Back to chats" render={<Link href="/app" />} nativeButton={false} className="wide:hidden">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h1 className="sr-only">{info?.thread.name ?? "Conversation"}</h1>
          <Button size="xl" onClick={() => setDetails(true)} aria-label="Details" className="min-w-0 max-w-full gap-2 pl-1.5 text-left xwide:pointer-events-none">
            {bot ? <BotAvatar bot={bot} size={32} /> : <Users className="ml-2 size-5" aria-hidden="true" />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] leading-5 font-semibold">{info?.thread.name ?? "…"}</span>
              <span className={cn("truncate text-[11px] leading-3.5 font-normal opacity-70", (busy || boxUpdating) && "shimmer")}>
                {bot ? bot.title || "Teammate" : info ? `${info.thread.members.length} bots` : ""}
                {boxUpdating ? " · the computer is updating, replies wait" : busy ? " · working" : ""}
              </span>
            </span>
          </Button>
          <span className="flex-1" />
          {busy ? (
            <Button variant="outline" size="sm" onClick={() => void post(`/api/threads/${threadId}/interrupt`)}>
              <Square className="fill-current" data-icon="inline-start" aria-hidden="true" />
              Stop
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<Button size="icon-xl" aria-label="Toggle details" aria-pressed={panel} onClick={() => setPanel((p) => !p)} className={cn("hidden xwide:inline-flex", panel && "bg-primary/85")} />}>
              <PanelRight aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Details</TooltipContent>
          </Tooltip>
          {actions.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-xl" aria-label="More" />}>
                <EllipsisVertical aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {actions.map((group, i) => (
                  <DropdownMenuGroup key={i}>
                    {i > 0 ? <DropdownMenuSeparator /> : null}
                    {group.map((action) => (
                      <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onClick={action.run}>
                        <action.icon aria-hidden="true" />
                        {action.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </header>

        <MessageScrollerProvider autoScroll>
          <JumpToMessage id={jumpTo} ready={messages.length > 0} />
          <MessageScroller className="flex-1">
            <MessageScrollerViewport className="px-3 sm:px-4">
              <MessageScrollerContent className="gap-3 py-4">
                {messages.length === 0 && info ? (
                  <MessageScrollerItem className="m-auto">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia>{bot ? <BotAvatar bot={bot} size={56} greet /> : <div className="flex -space-x-2">{members.slice(0, 4).map((b) => <BotAvatar key={b.id} bot={b} size={36} />)}</div>}</EmptyMedia>
                        <EmptyTitle>{bot ? `${bot.name} is ready.` : "Say what needs doing."}</EmptyTitle>
                        <EmptyDescription>{bot ? "Give it a task with the outcome, the sources, what it must avoid, and what to return." : "Mention a bot with @ to address it. With nobody named, the Chief of Staff answers."}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                {messages.map((m) => (
                  <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.author === "you"} className={cn(m.id === jumpTo && "rounded-2xl ring-2 ring-ring/40")}>
                    <Line message={m} threadId={threadId} bots={bots} threads={threads} bot={bot} approvals={approvalMap} isRoom={Boolean(isRoom)} onDecide={decide} onOpenExchange={setExchange} />
                  </MessageScrollerItem>
                ))}
                {Object.entries(working).map(([botId, line]) => {
                  const b = bots.find((x) => x.id === botId);
                  return (
                    <MessageScrollerItem key={`working-${botId}`}>
                      <Marker>
                        {b ? <BotAvatar bot={b} size={22} /> : null}
                        <MarkerContent className="shimmer truncate font-mono text-[12px]">{line}</MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  );
                })}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* The composer: an attach circle beside a pill that holds the text and the send button. */}
        <form onSubmit={send} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} className="shrink-0 bg-background px-3 py-2.5 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-4 sm:py-3">
          {members.length ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {members.map((b) => (
                <Button key={b.id} type="button" variant="outline" size="xs" onClick={() => mention(b)}>
                  <BotAvatar bot={b} size={14} />@{handleOf(b.name)}
                </Button>
              ))}
            </div>
          ) : null}
          {files.length ? (
            <AttachmentGroup className="mb-2">
              {files.map((file, i) => (
                <Attachment key={`${file.name}-${i}`} size="sm" state="idle">
                  <AttachmentMedia variant="icon">
                    <Paperclip />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
                    <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== i))}>
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </AttachmentGroup>
          ) : null}
          {notice ? (
            <p role="alert" className="mb-2 text-[12.5px] text-destructive">
              {notice}
            </p>
          ) : null}
          <div className="relative flex items-end gap-2.5">
          {slash ? <SlashMenu kind={slash.kind} skills={skills} bots={bots} query={slash.query} selected={slash.selected} onPickSkill={(skill) => insertSkill(skill.slug)} onPickBot={insertBot} /> : null}
          <Tooltip>
            <TooltipTrigger render={<Button size="icon-xl" aria-label="Attach files" render={<label />} nativeButton={false} className="cursor-pointer" />}>
              <Plus aria-hidden="true" />
              <input type="file" multiple className="sr-only" accept="image/*,.pdf,.txt,.md,.csv,.json" onChange={(e) => attach([...(e.target.files ?? [])])} />
            </TooltipTrigger>
            <TooltipContent>Attach files</TooltipContent>
          </Tooltip>
          {/* 44px like the circle beside it; the send circle sits 6px in from the pill's edge. */}
          <InputGroup className="min-h-11 rounded-[22px] border-primary-edge pr-1.5 shadow-(--primary-shadow)">
            <InputGroupTextarea
              ref={textarea}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                trackSlash(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={onKey}
              onBlur={() => window.setTimeout(() => setSlash(null), 120)}
              onPaste={onPaste}
              rows={1}
              placeholder={bot ? `Message ${bot.name}` : "Message the room"}
              aria-label={bot ? `Message ${bot.name}` : "Message the room"}
              enterKeyHint={touch ? "enter" : "send"}
              className="max-h-40 min-h-[42px] px-4 py-2.5 text-[16px] leading-5 sm:text-[14px]"
            />
            <InputGroupAddon align="inline-end" className="mr-0 self-end pt-0 pr-0 pb-[5px] has-[>button]:mr-0">
              <Tooltip>
                <TooltipTrigger render={<InputGroupButton type="submit" variant="control" size="icon-sm" aria-label="Send" disabled={sending || (!draft.trim() && !files.length)} className="rounded-full" />}>
                  <SendHorizonal aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>{touch ? "Send" : "Send (Enter)"}</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          </InputGroup>
          </div>
        </form>
      </section>
      {panel && info ? <RightPanel thread={info.thread} bot={bot} working={busy} /> : null}
      {info ? <DetailsSheet open={details} onOpenChange={setDetails} thread={info.thread} bot={bot} working={busy} /> : null}
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />

      {exchange ? <ExchangeDialog threadId={threadId} withThreadId={exchange} onClose={() => setExchange(null)} /> : null}
    </div>
  );
}
