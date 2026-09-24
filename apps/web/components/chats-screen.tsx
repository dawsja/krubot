"use client";

import { Search, Square, SquareKanban } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PersonAvatar } from "@/components/bot-avatar";
import type { ShellDialog } from "@/components/shell";
import { openShellDialog } from "@/components/shell";
import { ApprovalsBadge, BotRows, BotSearchInput, NewMenu, useBotSearch } from "@/components/sidebar";
import { StopAllConfirm, useWorkingCount } from "@/components/stop-all";
import { useStore } from "@/components/store";
import { ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Home on a phone: the conversations as a screen of their own, like a
 * messaging app. Your picture top left opens Settings; the Board, Search
 * and New sit top right, and Search swaps the row for the field until it is closed.
 * The same list the sidebar shows on a desktop.
 */
export function ChatsScreen({ className }: { className?: string }) {
  const { me, needsYouCount } = useStore();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [searching, setSearching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const working = useWorkingCount();
  const { query, setQuery, rows, hits } = useBotSearch();
  const onOpen = (dialog: ShellDialog) => dialog && openShellDialog(dialog);
  function closeSearch() {
    setQuery("");
    setSearching(false);
  }
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <header className="flex h-[calc(56px+max(12px,env(safe-area-inset-top)))] shrink-0 items-center gap-2 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-2">
        <h1 className="sr-only">Chats</h1>
        {searching ? (
          <>
            {/* Opened by a tap, so the field may take focus and bring the keyboard up. */}
            <BotSearchInput query={query} setQuery={setQuery} autoFocus className="h-11" />
            <Button variant="ghost" size="lg" onClick={closeSearch} className="-mr-2">
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Link href="/app/settings" aria-label="Settings" className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <PersonAvatar name={me.name} avatar={me.avatar} size={44} />
            </Link>
            <span className="flex-1" />
            <Button size="icon-xl" aria-label={needsYouCount ? `Board, ${needsYouCount} waiting on you` : "Board"} render={<Link href="/app/board" />} nativeButton={false} className="relative">
              <SquareKanban aria-hidden="true" className="size-5" />
              {needsYouCount ? <span className="absolute top-2 right-2 size-2.5 rounded-full bg-amber ring-2 ring-primary" aria-hidden="true" /> : null}
            </Button>
            <Button size="icon-xl" aria-label="Search" onClick={() => setSearching(true)}>
              <Search aria-hidden="true" className="size-5" />
            </Button>
            <NewMenu onOpen={onOpen} size="icon-xl" />
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <ApprovalsBadge className="mx-1 mb-2 w-[calc(100%-8px)]" />
        {/* While anything works: one tap (and a confirm) stops every bot and what they set going. */}
        {working ? (
          <Button variant="outline" onClick={() => setStopping(true)} className="mx-1 mb-2 h-11 w-[calc(100%-8px)] justify-start gap-2">
            <Square className="fill-current" data-icon="inline-start" aria-hidden="true" />
            Stop all
            <span className="ml-auto text-muted-foreground">{working === 1 ? "1 working" : `${working} working`}</span>
          </Button>
        ) : null}
        <BotRows rows={rows} hits={hits} query={query} setQuery={setQuery} onOpen={onOpen} onAsk={setAsk} />
      </div>
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
      <StopAllConfirm open={stopping} onOpenChange={setStopping} />
    </div>
  );
}
