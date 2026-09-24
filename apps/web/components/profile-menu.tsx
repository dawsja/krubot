"use client";

import { ChartColumn, LogOut, Settings, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactElement, type ReactNode } from "react";
import { StopAllConfirm, useWorkingCount } from "@/components/stop-all";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth/client";

/** Ends the session and goes to the sign-in page. */
export function useSignOut() {
  const router = useRouter();
  return async function signOut() {
    const { data } = await authClient.signOut();
    // Signed in with the OIDC provider: the client is already on its way to the
    // provider's sign-out, which comes back to /login.
    if (data?.redirect && data.url) return;
    router.replace("/login");
    router.refresh();
  };
}

/**
 * You: Settings, Usage and Sign out, the sidebar's footer on a desktop, and
 * Stop all while any bot is working. A phone has Usage and Sign out at the
 * end of Settings and Stop all on the Chats screen instead.
 */
export function ProfileMenu({ trigger, children, side = "top", align = "start" }: { trigger: ReactElement; children: ReactNode; side?: "top" | "bottom"; align?: "start" | "end" }) {
  const signOut = useSignOut();
  const working = useWorkingCount();
  const [stopping, setStopping] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
        <DropdownMenuContent side={side} align={align} className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuItem render={<Link href="/app/settings" />}>
              <Settings aria-hidden="true" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/app/usage" />}>
              <ChartColumn aria-hidden="true" />
              Usage
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {working ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={() => setStopping(true)}>
                  <Square aria-hidden="true" />
                  Stop all bots
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <StopAllConfirm open={stopping} onOpenChange={setStopping} />
    </>
  );
}
