"use client";

import type { Bot } from "@krubot/shared";
import { Copy, Eraser, Monitor, Pencil, Pin, PinOff, Trash2, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Confirm } from "@/components/confirm-dialog";
import type { ShellDialog } from "@/components/shell";
import { useStore, type ThreadRow } from "@/components/store";
import { del, patch, post } from "@/lib/api";

/*
 * Everything you can do to a conversation, in one list: the sidebar's
 * right-click (or long-press) menu and the conversation header's menu on a
 * phone draw the same items, and the two confirms live here too.
 */

export type Ask = { kind: "clear" | "delete"; thread: ThreadRow };

export type ThreadAction = { id: string; label: string; icon: LucideIcon; run: () => void; destructive?: boolean };

export function threadActions({ thread, bot, admin, onOpen, onAsk, refresh }: { thread: ThreadRow; bot: Bot | undefined; admin: boolean; onOpen: (dialog: NonNullable<ShellDialog>) => void; onAsk: (ask: Ask) => void; refresh: () => Promise<void> }): ThreadAction[][] {
  const groups: ThreadAction[][] = [];
  if (bot) {
    groups.push([
      { id: "edit", label: "Edit profile", icon: Pencil, run: () => onOpen({ kind: "edit-bot", botId: bot.id }) },
      { id: "pin", label: bot.pinned ? "Unpin" : "Pin to the top", icon: bot.pinned ? PinOff : Pin, run: () => void patch(`/api/bots/${bot.id}`, { pinned: !bot.pinned }).then(() => refresh()) },
      // The computer is one machine every bot shares, so only the admin opens it.
      ...(admin ? [{ id: "computer", label: "Open its computer", icon: Monitor, run: () => onOpen({ kind: "computer", botId: bot.id }) }] : []),
      {
        id: "duplicate",
        label: "Duplicate",
        icon: Copy,
        run: () =>
          void post(`/api/bots/${bot.id}/duplicate`)
            .then(() => refresh())
            .catch(() => undefined),
      },
    ]);
  }
  groups.push([
    { id: "clear", label: "Clear conversation", icon: Eraser, run: () => onAsk({ kind: "clear", thread }) },
    { id: "delete", label: bot ? "Delete bot" : "Delete room", icon: Trash2, destructive: true, run: () => onAsk({ kind: "delete", thread }) },
  ]);
  return groups;
}

/** The confirms behind "Clear conversation" and "Delete"; mount once near the menus. */
export function ThreadConfirms({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const { bots, refresh } = useStore();
  const pathname = usePathname();
  const router = useRouter();
  const askBot = ask?.thread.botId ? bots.find((b) => b.id === ask.thread.botId) : undefined;

  async function clearAsked() {
    if (!ask) return;
    await del(`/api/threads/${ask.thread.id}/messages`).catch(() => undefined);
    await refresh();
  }
  async function deleteAsked() {
    if (!ask) return;
    await (askBot ? del(`/api/bots/${askBot.id}`) : del(`/api/rooms/${ask.thread.id}`)).catch(() => undefined);
    await refresh();
    if (pathname === `/app/t/${ask.thread.id}`) router.replace("/app");
  }

  return (
    <>
      <Confirm
        open={ask?.kind === "clear"}
        onOpenChange={(open) => !open && onClose()}
        title="Clear this conversation?"
        description="Every message here is removed. The bot's memory stays."
        action="Clear"
        onConfirm={() => void clearAsked()}
      />
      <Confirm
        open={ask?.kind === "delete"}
        onOpenChange={(open) => !open && onClose()}
        title={askBot ? `Delete ${askBot.name}?` : "Delete this room?"}
        description={askBot ? "Its conversation and its files on the computer go with it. This can't be undone." : "The room and its messages are removed. The bots stay."}
        action="Delete"
        onConfirm={() => void deleteAsked()}
      />
    </>
  );
}
