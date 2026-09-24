"use client";

import { boardItemClearable, type BoardItem } from "@krubot/shared";
import { ArrowLeftRight, ArrowRight, Clock, ShieldQuestion, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ActionCard } from "@/components/action-card";
import { BotAvatar } from "@/components/bot-avatar";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { post } from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";

/*
 * One thing on the board, on the same shell as every card a bot puts in a
 * conversation. What it needs from you is said by its buttons: an approval
 * answers here, a handoff opens the exchange, anything opens its
 * conversation, and a finished one can be cleared off.
 */

const HEADINGS: Record<BoardItem["kind"], string> = {
  approval: "asks to",
  handoff: "Handoff",
  turn: "Working",
  run: "Routine",
  upcoming: "Scheduled",
};

function Icon({ kind }: { kind: BoardItem["kind"] }) {
  const className = "size-3.5";
  if (kind === "approval") return <ShieldQuestion className={className} aria-hidden="true" />;
  if (kind === "handoff") return <ArrowLeftRight className={className} aria-hidden="true" />;
  if (kind === "turn") return <Sparkles className={className} aria-hidden="true" />;
  return <Clock className={className} aria-hidden="true" />;
}

export function BoardCard({ item, onOpenExchange }: { item: BoardItem; onOpenExchange: (threadId: string, withThreadId: string) => void }) {
  const { botById, threads, activity, refresh } = useStore();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const bot = botById(item.botId);
  const to = item.toBotId ? botById(item.toBotId) : undefined;
  const room = threads.find((t) => t.id === item.threadId)?.kind === "room";
  const line = item.kind === "turn" ? activity[item.threadId]?.[item.botId] : undefined;

  async function decide(decision: "allow" | "deny") {
    if (busy) return;
    setBusy(true);
    try {
      await post(`/api/approvals/${item.id.slice("approval:".length)}`, { decision });
      toast.add({ type: "success", title: decision === "allow" ? "Allowed." : "Denied." });
      await refresh();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not answer it." });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    try {
      await post("/api/board/clear", { ids: [item.id] });
      await refresh();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not clear it." });
      setBusy(false);
    }
  }

  const heading = item.kind === "approval" ? `${bot?.name ?? "A bot"} ${HEADINGS.approval}` : HEADINGS[item.kind];

  return (
    <ActionCard icon={<Icon kind={item.kind} />} title={heading} fill>
      {item.kind !== "approval" ? (
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
          {bot ? <BotAvatar bot={bot} size={20} /> : <Users className="size-4" aria-hidden="true" />}
          <span className="truncate">{bot?.name ?? "A bot"}</span>
          {to ? (
            <>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-label="to" />
              <BotAvatar bot={to} size={20} />
              <span className="truncate">{to.name}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {/* A turn's text is what the bot is doing right now; its conversation is the bot's own unless it's a room. */}
      <p className={item.kind === "approval" ? "font-mono text-[12.5px] leading-5 break-words" : "line-clamp-2 text-[13.5px] leading-5"}>
        {item.kind === "turn" ? (line ?? "Thinking…") : item.title}
      </p>
      <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
        {item.kind === "turn" ? <Spinner className="size-3 shrink-0" /> : null}
        <span className="truncate">{item.kind === "turn" ? (room ? `In ${item.title}` : "") : (item.detail ?? "")}</span>
        {now !== null ? <span className="ml-auto shrink-0 tabular-nums">{relativeTime(item.at, now)}</span> : null}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {item.kind === "approval" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => void decide("allow")}>
              Allow once
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </Button>
          </>
        ) : null}
        {item.kind === "handoff" && item.toThreadId ? (
          <Button variant="outline" size="sm" onClick={() => onOpenExchange(item.threadId, item.toThreadId!)}>
            See exchange
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" render={<Link href={`/app/t/${item.threadId}`} />} nativeButton={false}>
          Open
        </Button>
        {boardItemClearable(item) ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clear()} className="ml-auto">
            Clear
          </Button>
        ) : null}
      </div>
    </ActionCard>
  );
}
