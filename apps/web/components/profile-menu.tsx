"use client";

import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth/client";

/** You: Settings and Sign out. The sidebar's footer on a desktop, your picture on a phone. */
export function ProfileMenu({ trigger, children, side = "top", align = "start" }: { trigger: ReactElement; children: ReactNode; side?: "top" | "bottom"; align?: "start" | "end" }) {
  const router = useRouter();
  async function signOut() {
    const { data } = await authClient.signOut();
    // Signed in with the OIDC provider: the client is already on its way to the
    // provider's sign-out, which comes back to /login.
    if (data?.redirect && data.url) return;
    router.replace("/login");
    router.refresh();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/app/settings" />}>
            <Settings aria-hidden="true" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
