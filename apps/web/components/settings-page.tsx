"use client";

import type { AiSettings, BoxStatus, Settings } from "@krubot/shared";
import { ChartColumn, ChevronLeft, ChevronRight, LogOut } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AboutCard } from "@/components/about-card";
import { AccountSection } from "@/components/account-section";
import { AppsCard } from "@/components/apps-card";
import { ComposioCard } from "@/components/composio-card";
import { ComputerCard } from "@/components/computer-card";
import { EngineCard } from "@/components/engine-card";
import { McpCard } from "@/components/mcp-card";
import { NotificationsCard } from "@/components/notifications-card";
import { OidcCard } from "@/components/oidc-card";
import { ProvidersCard } from "@/components/providers-card";
import { ServerCard } from "@/components/server-card";
import { SkillsCard } from "@/components/skills-card";
import { UsersCard } from "@/components/users-card";
import { useLiveEvents } from "@/components/hq/live-events";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PersonAvatar } from "@/components/bot-avatar";
import { useSignOut } from "@/components/profile-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { api, patch } from "@/lib/api";
import type { SessionUser } from "@/lib/session";
import { SETTINGS_SECTIONS, sectionsFor, settingsHref, type SettingsSection } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";

export function SettingsPage({ user, section, index = false }: { user: SessionUser; section: SettingsSection; index?: boolean }) {
  const { me, admin } = useStore();
  const params = useSearchParams();
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  // A new Composio key gives a different project's apps: the card below reloads on it.
  const [appsRefresh, setAppsRefresh] = useState(0);
  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const signOut = useSignOut();
  // On a phone the list goes back to Chats and a section back to the list.
  const back = index ? "/app" : "/app/settings";
  useSwipeBack(back);
  // On a phone the sections are a row that scrolls; keep the open one in view.
  const activeLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeLink.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current.id]);

  const load = useCallback(async (fresh = false) => {
    // Everyone has their own AI and their own account on the computer.
    const [s, a, st] = await Promise.all([
      api<{ settings: Settings }>("/api/settings").catch(() => null),
      api<{ ai: AiSettings }>("/api/ai").catch(() => null),
      api<{ status: BoxStatus }>(`/api/status${fresh ? "?fresh=1" : ""}`).catch(() => null),
    ]);
    if (s) setSettings(s.settings);
    if (a) setAi(a.ai);
    if (st) setStatus(st.status);
  }, []);

  useEffect(() => {
    const connected = params.get("connected");
    const mcp = params.get("mcp");
    const mcpError = params.get("mcp_error");
    void Promise.resolve().then(() => {
      if (mcp) toast.add({ type: "success", title: `Signed in to ${mcp}.`, description: "Its tools work for the bots it is given to from their next reply." });
      if (mcpError) toast.add({ type: "error", title: "MCP sign-in didn't complete.", description: mcpError });
      return load(Boolean(connected));
    });
  }, [load, params]);
  useLiveEvents((event) => {
    if (event.topic === "settings" || event.topic === "ai") void load();
    // When the update finishes, the box answers with its new versions.
    if (event.topic === "box") void load();
  });

  // A phone shows the sections as a list of their own, then one at a time.
  const list = (
    <nav aria-label="Settings sections" className="flex flex-col gap-1">
      <Link href={settingsHref("account")} className="mb-2 flex items-center gap-3 rounded-2xl bg-card px-3 py-3 shadow-subtle outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <PersonAvatar name={me.name} avatar={me.avatar} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{me.name}</span>
          <span className="block truncate text-[12.5px] text-muted-foreground">{me.provider === "local" ? "Picture, password, theme, notifications" : "Picture, theme, notifications"}</span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
      </Link>
      {sectionsFor(me.role).filter((s) => s.id !== "account").map((s) => {
        const Icon = s.icon;
        return (
          <Link key={s.id} href={settingsHref(s.id)} className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 outline-none hover:bg-card/60 focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium">{s.label}</span>
              <span className="block truncate text-[12.5px] text-muted-foreground">{s.blurb}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        );
      })}
      {/* Usage and Sign out end the list: on a phone your picture opens Settings directly, there is no menu. */}
      <Link href="/app/usage" className="mt-4 flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 outline-none hover:bg-card/60 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
          <ChartColumn className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium">Usage</span>
          <span className="block truncate text-[12.5px] text-muted-foreground">Tokens and cost, by day and by bot</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
      <button type="button" onClick={() => void signOut()} className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-left outline-none hover:bg-card/60 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
          <LogOut className="size-4" aria-hidden="true" />
        </span>
        <span className="block text-[15px] font-medium">Sign out</span>
      </button>
    </nav>
  );

  const nav = (
    <nav aria-label="Settings sections" className="hidden gap-1 overflow-x-auto wide:flex wide:w-44 wide:shrink-0 wide:flex-col wide:overflow-visible">
      {sectionsFor(me.role).map((s) => {
        const active = s.id === current.id;
        const Icon = s.icon;
        return (
          <Link
            key={s.id}
            ref={active ? activeLink : undefined}
            href={settingsHref(s.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 shrink-0 items-center gap-2.5 rounded-xl px-3 text-[13.5px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              active ? "bg-card text-foreground shadow-subtle" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {s.label}
          </Link>
        );
      })}
    </nav>
  );

  let body: React.ReactNode;
  switch (current.id) {
    case "account":
      body = (
        <>
          <AccountSection user={user} />
          <NotificationsCard />
          <ServerCard />
          <AboutCard />
        </>
      );
      break;
    case "team":
      body = settings ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Team</CardTitle>
              <CardDescription>What the whole team shares.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup className="gap-4">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="timezone">Time zone</FieldLabel>
                    <FieldDescription>Routines and the bots&apos; sense of &quot;today&quot; use it.</FieldDescription>
                  </FieldContent>
                  <Input id="timezone" value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} onBlur={() => void patch("/api/settings", { timezone: settings.timezone })} className="w-56" />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
          <ComputerCard status={status} admin={admin} onCheck={() => load(true)} />
        </>
      ) : (
        <>
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </>
      );
      break;
    case "ai":
      body = (
        <>
          {ai ? <EngineCard ai={ai} status={status} onChange={setAi} onRefresh={() => void load(true)} /> : <Skeleton className="h-96 rounded-xl" />}
          <ProvidersCard ai={ai} onAiChange={setAi} />
        </>
      );
      break;
    case "skills":
      body = <SkillsCard />;
      break;
    case "apps":
      body = (
        <>
          <ComposioCard onChange={() => setAppsRefresh((n) => n + 1)} />
          <AppsCard refresh={appsRefresh} />
          <McpCard />
        </>
      );
      break;
    case "auth":
      body = (
        <>
          <OidcCard />
          <UsersCard />
        </>
      );
      break;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-[calc(32px+env(safe-area-inset-bottom))] wide:px-6 wide:py-8">
        {/* A phone: the list, or one section with a way back to it. */}
        <div className="flex h-11 items-center gap-3 wide:hidden">
          <Button size="icon-xl" aria-label={index ? "Back to chats" : "All settings"} render={<Link href={back} />} nativeButton={false}>
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h1 className="text-[22px] font-semibold tracking-[-0.4px]">{index ? "Settings" : current.label}</h1>
        </div>
        <h1 className="hidden text-[22px] font-semibold tracking-[-0.4px] wide:block">Settings</h1>
        {index ? <div className="wide:hidden">{list}</div> : null}
        <div className={cn("flex flex-col gap-5 wide:flex-row wide:items-start wide:gap-8", index && "hidden wide:flex")}>
          {nav}
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <div className={cn(!index && "hidden wide:block")}>
              <h2 className="text-[17px] font-semibold">{current.label}</h2>
              <p className="text-[13.5px] text-muted-foreground">{current.blurb}</p>
            </div>
            {!index ? <p className="-mt-3 text-[13.5px] text-muted-foreground wide:hidden">{current.blurb}</p> : null}
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}
