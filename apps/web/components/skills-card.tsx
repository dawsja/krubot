"use client";

import type { Skill } from "@krubot/shared";
import { BookOpen, Download, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { SkillDialog } from "@/components/skill-dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del, post } from "@/lib/api";

type Packaged = { id: string; name: string; description: string; installed: boolean };

/** Settings → Skills: the team's library, and the marketplace's packaged skills. */
export function SkillsCard() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [packaged, setPackaged] = useState<Packaged[]>([]);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [removing, setRemoving] = useState<Skill | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ skills: Skill[]; packaged: Packaged[] }>("/api/skills").catch(() => null);
    if (!data) return;
    setSkills(data.skills);
    setPackaged(data.packaged);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function install(id: string) {
    setInstalling(id);
    try {
      await post("/api/skills/install", { id });
      await load();
    } finally {
      setInstalling(null);
    }
  }

  const available = packaged.filter((p) => !p.installed);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>
          How to do a job, written once and shared by every bot: steps, decision rules, what the result looks like, what waits for approval. Type <Kbd>/</Kbd> in a message to hand one to a bot, or run one on a schedule from a routine. Bots save their own with save_skill.
        </CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            New skill
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!skills ? (
          <Spinner />
        ) : skills.length === 0 ? (
          <Empty className="border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpen />
              </EmptyMedia>
              <EmptyTitle>No skills yet</EmptyTitle>
              <EmptyDescription>Write one, install one from below, or ask a bot to save what it just did.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {skills.map((skill) => (
              <li key={skill.id} className="group flex items-start gap-3 rounded-xl border px-3 py-2">
                <button type="button" onClick={() => setEditing(skill)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium">{skill.name}</span>
                    <Badge variant="secondary" className="font-mono">
                      /{skill.slug}
                    </Badge>
                    {skill.source !== "written" ? <Badge variant="outline">{skill.source === "bot" ? "saved by a bot" : "from the marketplace"}</Badge> : null}
                  </span>
                  {skill.description ? <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{skill.description}</span> : null}
                </button>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Delete ${skill.name}`} onClick={() => setRemoving(skill)} className="text-destructive opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100" />}>
                    <Trash2 aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        {available.length ? (
          <div>
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">From the marketplace</h3>
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {available.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 rounded-xl border px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
                    <span className="block text-[11.5px] leading-4 text-muted-foreground">{p.description}</span>
                  </span>
                  <Button variant="outline" size="xs" disabled={installing === p.id} onClick={() => void install(p.id)}>
                    {installing === p.id ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" aria-hidden="true" />}
                    Install
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>

      {editing ? <SkillDialog skill={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} /> : null}
      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this skill?</AlertDialogTitle>
            <AlertDialogDescription>&ldquo;{removing?.name}&rdquo; leaves the library for every bot. Routines that run it keep their prompt.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void del(`/api/skills/${removing.id}`).then(load).finally(() => setRemoving(null))}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
