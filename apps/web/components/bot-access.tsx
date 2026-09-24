"use client";

import type { Bot } from "@krubot/shared";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { patch } from "@/lib/api";

/*
 * Which bots may use an app, from the app's side: one menu on its row in
 * Settings → Apps with every bot in it and "All bots" on top, so giving a
 * new app to the whole team, or taking it back, is one tap instead of a
 * visit to each profile. It writes the same `toolkits` the profile's pills
 * do; the store hears `bots` and both stay in step.
 */

/**
 * Each bot's toolkits as the last write left them. Writes to one bot run
 * one after another and each starts from the one before, so ticking two
 * apps quickly for the same bot never loses the first.
 */
const chains = new Map<string, Promise<string[]>>();

function setToolkit(bot: Bot, toolkit: string, on: boolean): Promise<string[]> {
  const before = chains.get(bot.id) ?? Promise.resolve(bot.toolkits);
  const next = before
    .catch(() => bot.toolkits)
    .then(async (toolkits) => {
      if (toolkits.includes(toolkit) === on) return toolkits;
      const wanted = on ? [...toolkits, toolkit] : toolkits.filter((t) => t !== toolkit);
      const data = await patch<{ bot: Bot }>(`/api/bots/${bot.id}`, { toolkits: wanted });
      // The API drops an app its owner can't use; say so rather than show a tick that didn't stick.
      if (on && !data.bot.toolkits.includes(toolkit)) throw new Error(`${bot.name} can't be given that app.`);
      return data.bot.toolkits;
    });
  chains.set(bot.id, next);
  void next.finally(() => {
    if (chains.get(bot.id) === next) chains.delete(bot.id);
  }).catch(() => undefined);
  return next;
}

export function BotAccessMenu({ toolkit, name }: { toolkit: string; name: string }) {
  const { bots, refresh } = useStore();
  // What was just ticked, shown at once while the writes land.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const has = (bot: Bot) => pending.get(bot.id) ?? bot.toolkits.includes(toolkit);
  const users = bots.filter(has);
  const all = bots.length > 0 && users.length === bots.length;

  async function set(targets: Bot[], on: boolean) {
    const changing = targets.filter((b) => has(b) !== on);
    if (!changing.length) return;
    setPending((current) => {
      const next = new Map(current);
      for (const b of changing) next.set(b.id, on);
      return next;
    });
    const results = await Promise.allSettled(changing.map((b) => setToolkit(b, toolkit, on)));
    await refresh().catch(() => undefined);
    setPending((current) => {
      const next = new Map(current);
      for (const b of changing) next.delete(b.id);
      return next;
    });
    const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : "Something went wrong."] : []));
    if (failed.length) toast.add({ type: "error", title: failed.length === changing.length ? `Couldn't change who uses ${name}.` : `Some bots couldn't be changed.`, description: failed[0] });
  }

  const summary = users.length === 0 ? "No bots" : all ? "All bots" : users.length === 1 ? users[0]!.name : `${users.length} bots`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="xs" aria-label={`Bots that can use ${name}: ${summary}`} className="max-w-36 gap-1 pointer-coarse:h-11 pointer-coarse:rounded-full pointer-coarse:px-4" />}
        disabled={!bots.length}
      >
        {users.length ? (
          <span className="flex -space-x-1.5" aria-hidden="true">
            {users.slice(0, 3).map((b) => (
              <BotAvatar key={b.id} bot={b} size={14} />
            ))}
          </span>
        ) : null}
        <span className="truncate">{summary}</span>
        <ChevronDown aria-hidden="true" className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Who can use {name}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={all} onCheckedChange={(on) => void set(bots, on)} closeOnClick={false}>
            <span className="flex-1">All bots</span>
            {/* Some but not all: say how many, since the box alone can't. */}
            {users.length && !all ? <span className="text-xs text-muted-foreground tabular-nums">{users.length} of {bots.length}</span> : null}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {bots.map((bot) => (
            <DropdownMenuCheckboxItem key={bot.id} checked={has(bot)} onCheckedChange={(on) => void set([bot], on)} closeOnClick={false}>
              <BotAvatar bot={bot} size={18} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
