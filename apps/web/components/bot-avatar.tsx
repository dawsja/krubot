"use client";

import type { Bot } from "@krubot/shared";
import { KruBot } from "@/components/hq/kru-bot";
import { useStore } from "@/components/store";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** A bot's face at a given size; `greet` plays the hello bounce on mount. */
export function BotAvatar({ bot, size = 24, greet = false, className }: { bot: Pick<Bot, "name" | "title" | "color" | "expression">; size?: number; greet?: boolean; className?: string }) {
  return (
    <span data-slot="bot-avatar" className={cn("inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <KruBot color={bot.color} size={size} expression={bot.expression} greet={greet} label={`${bot.name}${bot.title ? `, ${bot.title}` : ""}`} />
    </span>
  );
}

/** You: your picture from Settings when you set one, else your initial on ink. */
export function YouAvatar({ size = 24, className }: { size?: number; className?: string }) {
  const { me } = useStore();
  return <PersonAvatar name={me.name} avatar={me.avatar} size={size} className={className} />;
}

export function PersonAvatar({ name, avatar, size = 24, className }: { name: string; avatar: string | null; size?: number; className?: string }) {
  return (
    <Avatar className={cn("after:hidden", className)} style={{ width: size, height: size }} aria-label={name}>
      {avatar ? <AvatarImage src={avatar} alt="" /> : null}
      <AvatarFallback className="bg-primary font-semibold text-primary-foreground" style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}>
        {name.charAt(0).toUpperCase() || "Y"}
      </AvatarFallback>
    </Avatar>
  );
}
