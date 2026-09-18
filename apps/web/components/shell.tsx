"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BotDialog } from "@/components/bot-dialog";
import { ComputerPanel } from "@/components/computer-panel";
import { MobileNav } from "@/components/mobile-nav";
import { MobileNotifications } from "@/components/mobile-notifications";
import { RoomDialog } from "@/components/room-dialog";
import { AppSidebar } from "@/components/sidebar";
import { StoreProvider } from "@/components/store";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { SessionUser } from "@/lib/session";

export type ShellDialog = { kind: "new-bot" } | { kind: "edit-bot"; botId: string } | { kind: "new-room" } | { kind: "computer"; botId?: string | null } | null;

/**
 * The app. On a desktop: the bot list on the left (the shadcn sidebar), the
 * conversation in the middle, and whatever the page puts on the right. On a
 * phone: one screen at a time, with Chats, Computer and Settings in a bar at
 * the bottom (see mobile-nav.tsx) and a conversation on top of that. Dialogs
 * for creating bots and rooms and the computer panel live here so every page
 * can open them.
 */
export function Shell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const [dialog, setDialog] = useState<ShellDialog>(null);
  const admin = user.role === "admin";
  return (
    <StoreProvider user={user}>
      <SidebarProvider style={{ "--sidebar-width": "300px" } as React.CSSProperties} className="h-dvh min-h-0 overflow-hidden">
        <AppSidebar onOpen={setDialog} />
        <SidebarInset className="min-h-0 min-w-0">
          {children}
          <MobileNav />
        </SidebarInset>
      </SidebarProvider>
      {dialog?.kind === "new-bot" || dialog?.kind === "edit-bot" ? <BotDialog botId={dialog.kind === "edit-bot" ? dialog.botId : null} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "new-room" ? <RoomDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "computer" && admin ? (
        <ComputerPanel
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ShellDialogBridge open={setDialog} />
      <MobileNotifications />
    </StoreProvider>
  );
}

/*
 * Pages deeper in the tree open shell dialogs by dispatching a DOM event;
 * cheaper than threading a callback through every component.
 */
export const OPEN_DIALOG_EVENT = "kru:open-dialog";

export function openShellDialog(dialog: NonNullable<ShellDialog>) {
  window.dispatchEvent(new CustomEvent(OPEN_DIALOG_EVENT, { detail: dialog }));
}

function ShellDialogBridge({ open }: { open: (dialog: ShellDialog) => void }) {
  useEffect(() => {
    const onOpen = (event: Event) => open((event as CustomEvent<NonNullable<ShellDialog>>).detail);
    window.addEventListener(OPEN_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIALOG_EVENT, onOpen);
  }, [open]);
  return null;
}
