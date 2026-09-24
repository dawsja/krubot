"use client";

import { handleOf, type Bot, type Skill } from "@krubot/shared";
import { BotAvatar } from "@/components/bot-avatar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api";

/**
 * The / menu in the composer: your skills library, filtered by what follows
 * the slash, fetched again when a bot saves a new one. The composer keeps the keyboard; this just shows the choices
 * and says which is highlighted.
 */
export function useSkillsLibrary(): Skill[] {
  const [skills, setSkills] = useState<Skill[]>([]);
  const load = useCallback(
    () =>
      api<{ skills: Skill[] }>("/api/skills")
        .then((d) => setSkills(d.skills))
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "skills") void load();
  });
  return skills;
}

/** The / or @ token being typed at the caret, if any: "/mor" → { kind: "skill", query: "mor" }. */
export function slashQuery(text: string, caret: number): { kind: "skill" | "bot"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([/@])([a-z0-9_-]*)$/i.exec(before);
  if (!match) return null;
  return { kind: match[1] === "/" ? "skill" : "bot", query: match[2]!.toLowerCase(), start: caret - match[2]!.length - 1 };
}

/** Bots whose name or handle matches. */
export function matchBots(bots: Bot[], query: string): Bot[] {
  const q = query.toLowerCase();
  return bots.filter((b) => !b.hidden && (handleOf(b.name).includes(q) || b.name.toLowerCase().includes(q))).slice(0, 8);
}

export function matchSkills(skills: Skill[], query: string): Skill[] {
  const q = query.toLowerCase();
  return skills.filter((s) => s.slug.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 8);
}

export function SlashMenu({ kind, skills, bots, query, selected, onPickSkill, onPickBot }: { kind: "skill" | "bot"; skills: Skill[]; bots: Bot[]; query: string; selected: number; onPickSkill: (skill: Skill) => void; onPickBot: (bot: Bot) => void }) {
  const skillMatches = useMemo(() => (kind === "skill" ? matchSkills(skills, query) : []), [kind, skills, query]);
  const botMatches = useMemo(() => (kind === "bot" ? matchBots(bots, query) : []), [kind, bots, query]);
  const current = kind === "skill" ? (skillMatches[selected]?.id ?? "") : (botMatches[selected]?.id ?? "");
  const empty = kind === "skill" ? (skills.length ? "No skill matches." : "No skills yet. Add one under Settings → Skills.") : "No bot matches.";
  return (
    <div className="absolute inset-x-0 bottom-full z-10 mb-2 overflow-hidden rounded-xl border bg-popover shadow-md" role="listbox" aria-label={kind === "skill" ? "Skills" : "Bots"}>
      <Command value={current} shouldFilter={false} loop>
        <CommandList className="max-h-64">
          {skillMatches.length === 0 && botMatches.length === 0 ? <CommandEmpty>{empty}</CommandEmpty> : null}
          {kind === "skill" ? (
            <CommandGroup heading="Skills">
              {skillMatches.map((skill) => (
                <CommandItem key={skill.id} value={skill.id} onSelect={() => onPickSkill(skill)} onMouseDown={(e) => e.preventDefault()}>
                  <span className="font-mono text-[12.5px]">/{skill.slug}</span>
                  <span className="truncate text-muted-foreground">{skill.description || skill.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            <CommandGroup heading="Bots">
              {botMatches.map((bot) => (
                <CommandItem key={bot.id} value={bot.id} onSelect={() => onPickBot(bot)} onMouseDown={(e) => e.preventDefault()}>
                  <BotAvatar bot={bot} size={18} />
                  <span className="font-medium">{bot.name}</span>
                  <span className="truncate font-mono text-[12px] text-muted-foreground">@{handleOf(bot.name)}</span>
                  {bot.title ? <span className="truncate text-muted-foreground">· {bot.title}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex items-center gap-2 border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <Kbd>↑↓</Kbd> choose <Kbd>Tab</Kbd> insert <Kbd>Esc</Kbd> close
        </div>
      </Command>
    </div>
  );
}
