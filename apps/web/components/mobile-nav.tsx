"use client";

import { MessageCircle, Monitor, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/components/store";
import { cn } from "@/lib/utils";

/*
 * The bottom bar on a phone: Chats, Computer and Settings, the three
 * places the app has. Hidden inside a conversation so the composer sits
 * at the bottom, and on the computer, which is a screen of its own.
 */
const TABS = [
  { href: "/app", label: "Chats", icon: MessageCircle, match: (p: string) => p === "/app" || p.startsWith("/app/t/") },
  { href: "/app/computer", label: "Computer", icon: Monitor, match: (p: string) => p.startsWith("/app/computer") },
  { href: "/app/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/app/settings") },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const { threads, approvals, admin } = useStore();
  if (pathname.startsWith("/app/t/") || pathname.startsWith("/app/computer")) return null;
  const tabs = TABS.filter((tab) => admin || tab.href !== "/app/computer");
  const unread = threads.reduce((n, t) => n + (t.unread > 0 ? 1 : 0), 0) + approvals.length;
  return (
    <nav aria-label="Main" className="shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] wide:hidden">
      <ul className="flex h-16 items-stretch">
        {tabs.map((tab) => {
          const active = tab.match(pathname);
          return (
            <li key={tab.href} className="flex-1">
              <Link href={tab.href} aria-current={active ? "page" : undefined} className={cn("relative flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset", active ? "text-foreground" : "text-muted-foreground")}>
                <span className={cn("flex h-8 w-14 items-center justify-center rounded-full transition-colors", active && "bg-muted")}>
                  <tab.icon className="size-5" aria-hidden="true" />
                  {tab.href === "/app" && unread > 0 ? <span className="absolute top-2 left-1/2 ml-1.5 size-2 rounded-full bg-brand" aria-label={`${unread} conversations need you`} /> : null}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
