"use client";

import { BOARD_COLUMN_LABELS, BOARD_COLUMNS, type BoardColumn, type BoardItem } from "@krubot/shared";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BoardCard } from "@/components/board-card";
import { ExchangeDialog } from "@/components/exchange-dialog";
import { useStore } from "@/components/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

/*
 * The board: every bot's work at once. A desktop shows the five columns
 * side by side; a phone shows one at a time behind a row of pills, and
 * opens on whatever waits on you.
 */

const EMPTY: Record<BoardColumn, string> = {
  "needs-you": "Nothing waits on you.",
  working: "No bot is working right now.",
  waiting: "Nothing is queued or scheduled.",
  stalled: "No handoff has gone quiet.",
  done: "Nothing finished in the last day.",
};

function Column({ column, items, loaded, onOpenExchange, className }: { column: BoardColumn; items: BoardItem[]; loaded: boolean; onOpenExchange: (threadId: string, withThreadId: string) => void; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-2", className)} aria-label={BOARD_COLUMN_LABELS[column]}>
      {!loaded ? (
        Array.from({ length: 2 }, (_, i) => (
          <li key={i}>
            <Skeleton className="h-28 w-full rounded-2xl" />
          </li>
        ))
      ) : items.length === 0 ? (
        <li>
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyDescription>{EMPTY[column]}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </li>
      ) : (
        items.map((item) => (
          <li key={item.id}>
            <BoardCard item={item} onOpenExchange={onOpenExchange} />
          </li>
        ))
      )}
    </ul>
  );
}

/** Clears every card under Done. */
function ClearDone({ count, className }: { count: number; className?: string }) {
  const { refresh } = useStore();
  const [busy, setBusy] = useState(false);
  if (count === 0) return null;
  async function clear() {
    setBusy(true);
    try {
      await post("/api/board/clear", {});
      await refresh();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not clear them." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clear()} className={className}>
      Clear all
    </Button>
  );
}

export function BoardScreen() {
  const { board } = useStore();
  useSwipeBack("/app");
  const [picked, setPicked] = useState<BoardColumn | null>(null);
  const [exchange, setExchange] = useState<{ threadId: string; withThreadId: string } | null>(null);
  const loaded = board !== null;
  const items = (column: BoardColumn) => board?.columns[column] ?? [];
  // A phone opens on what waits on you, or on what is running when nothing does.
  const shown = picked ?? (items("needs-you").length ? "needs-you" : "working");
  const openExchange = (threadId: string, withThreadId: string) => setExchange({ threadId, withThreadId });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 wide:px-6 wide:pt-8 wide:pb-5">
        <Button size="icon-xl" aria-label="Back to chats" render={<Link href="/app" />} nativeButton={false} className="wide:hidden">
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-[-0.4px]">Board</h1>
          <p className="hidden text-[13.5px] text-muted-foreground wide:block">What your bots are on, and what finished in the last day.</p>
        </div>
      </header>

      {/* A phone: one column at a time. */}
      <div className="shrink-0 overflow-x-auto px-4 pb-2 wide:hidden">
        <ToggleGroup variant="pill" value={[shown]} onValueChange={(v) => v[0] && setPicked(v[0] as BoardColumn)} className="w-max" aria-label="Column">
          {BOARD_COLUMNS.map((column) => (
            <ToggleGroupItem key={column} value={column} className="h-11 gap-1.5 px-4">
              {BOARD_COLUMN_LABELS[column]}
              {items(column).length ? <span className="tabular-nums opacity-70">{items(column).length}</span> : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-[calc(16px+env(safe-area-inset-bottom))] wide:hidden">
        {shown === "done" ? (
          <div className="flex justify-end pb-2">
            <ClearDone count={items("done").length} />
          </div>
        ) : null}
        <Column column={shown} items={items(shown)} loaded={loaded} onOpenExchange={openExchange} />
      </div>

      {/* A desktop: every column side by side, each scrolling on its own. */}
      <div className="hidden min-h-0 flex-1 gap-4 overflow-x-auto px-6 pb-6 wide:flex xwide:grid xwide:grid-cols-5 xwide:overflow-x-visible">
        {BOARD_COLUMNS.map((column) => (
          <section key={column} className="flex min-h-0 w-72 shrink-0 flex-col gap-3 xwide:w-auto">
            <h2 className="flex items-center gap-2 px-1 text-[13.5px] font-semibold">
              {BOARD_COLUMN_LABELS[column]}
              <Badge variant="secondary" className="tabular-nums">
                {loaded ? items(column).length : "–"}
              </Badge>
              {column === "done" ? <ClearDone count={items("done").length} className="ml-auto -my-1" /> : null}
            </h2>
            <Column column={column} items={items(column)} loaded={loaded} onOpenExchange={openExchange} className="min-h-0 flex-1 overflow-y-auto pb-2" />
          </section>
        ))}
      </div>

      {exchange ? <ExchangeDialog threadId={exchange.threadId} withThreadId={exchange.withThreadId} onClose={() => setExchange(null)} /> : null}
    </div>
  );
}
