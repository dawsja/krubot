"use client";

import { useState } from "react";
import { PersonAvatar } from "@/components/bot-avatar";
import { ProfileMenu } from "@/components/profile-menu";
import type { ShellDialog } from "@/components/shell";
import { openShellDialog } from "@/components/shell";
import { ApprovalsBadge, BotRows, BotSearchInput, NewMenu, useBotSearch } from "@/components/sidebar";
import { useStore } from "@/components/store";
import { ThreadConfirms, type Ask } from "@/components/thread-actions";
import { cn } from "@/lib/utils";

/**
 * Home on a phone: the conversations as a screen of their own, like a
 * messaging app, with you (Settings, Sign out) top left and New top right.
 * The same list the sidebar shows on a desktop.
 */
export function ChatsScreen({ className }: { className?: string }) {
  const { me } = useStore();
  const [ask, setAsk] = useState<Ask | null>(null);
  const { query, setQuery, rows, hits } = useBotSearch();
  const onOpen = (dialog: ShellDialog) => dialog && openShellDialog(dialog);
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <header className="flex shrink-0 flex-col gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-2">
        <div className="flex h-11 items-center gap-3">
          <ProfileMenu side="bottom" trigger={<button type="button" aria-label="Your menu" className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />}>
            <PersonAvatar name={me.name} avatar={me.avatar} size={36} />
          </ProfileMenu>
          <h1 className="flex-1 text-[22px] font-semibold tracking-[-0.4px]">Chats</h1>
          <NewMenu onOpen={onOpen} />
        </div>
        <BotSearchInput query={query} setQuery={setQuery} className="h-10" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <ApprovalsBadge className="mx-1 mb-2 w-[calc(100%-8px)]" />
        <BotRows rows={rows} hits={hits} query={query} setQuery={setQuery} onOpen={onOpen} onAsk={setAsk} />
      </div>
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}
