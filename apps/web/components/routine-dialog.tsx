"use client";

import { ROUTINE_PRESETS, type Bot, type Routine, type Skill } from "@krubot/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, patch, post } from "@/lib/api";

export function RoutineDialog({ bot, routine, onClose, onSaved }: { bot: Bot; routine: Routine | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState(routine?.name ?? "");
  const [cron, setCron] = useState(routine?.cron ?? ROUTINE_PRESETS[0]!.cron);
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [skillId, setSkillId] = useState<string>(routine?.skillId ?? "");
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    void Promise.resolve().then(() =>
      api<{ skills: Skill[] }>("/api/skills")
        .then((d) => setSkills(d.skills))
        .catch(() => undefined),
    );
  }, []);
  const skillItems = [{ value: "", label: "None, just the prompt" }, ...skills.map((s) => ({ value: s.id, label: `/${s.slug} · ${s.name}` }))];
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      post<{ runs: string[] }>("/api/routines/preview", { cron, timezone: routine?.timezone ?? timezone })
        .then((d) => {
          setPreview(d.runs);
          setError(null);
        })
        .catch((e: Error) => {
          setPreview([]);
          setError(e.message);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [cron, timezone, routine?.timezone]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), cron: cron.trim(), prompt: prompt.trim(), enabled, timezone: routine?.timezone ?? timezone, skillId: skillId || null };
      if (routine) await patch(`/api/routines/${routine.id}`, body);
      else await api(`/api/bots/${bot.id}/routines`, { method: "POST", body: JSON.stringify(body) });
      await onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  const nextRuns = preview
    .slice(0, 3)
    .map((d) => new Date(d).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }))
    .join(" · ");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{routine ? "Edit routine" : `New routine for ${bot.name}`}</DialogTitle>
          <DialogDescription>A prompt {bot.name} runs on a schedule, in your time zone ({routine?.timezone ?? timezone}). Its answer lands in your conversation.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="routine-name">Name</FieldLabel>
              <Input id="routine-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Morning briefing" />
            </Field>
            <Field data-invalid={error && !busy ? true : undefined}>
              <FieldLabel htmlFor="routine-cron">When</FieldLabel>
              <ToggleGroup variant="pill" size="sm" value={[cron]} onValueChange={(v) => v[0] && setCron(v[0])} className="flex-wrap">
                {ROUTINE_PRESETS.map((p) => (
                  <ToggleGroupItem key={p.cron} value={p.cron}>
                    {p.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <Input id="routine-cron" value={cron} onChange={(e) => setCron(e.target.value)} required className="font-mono" aria-label="Cron expression" aria-invalid={error ? true : undefined} />
              {error ? <FieldError>{error}</FieldError> : <FieldDescription>{preview.length ? `Next: ${nextRuns}` : "Five fields: minute hour day-of-month month day-of-week."}</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel htmlFor="routine-skill">Skill</FieldLabel>
              <Select items={skillItems} value={skillId} onValueChange={(value) => setSkillId(value ?? "")}>
                <SelectTrigger id="routine-skill" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {skillItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>From your library (Settings → Skills). The prompt below then carries the inputs for it.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="routine-prompt">What to do</FieldLabel>
              <Textarea id="routine-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} required rows={4} maxLength={4000} placeholder="Review everything new since yesterday and…" />
            </Field>
            <FieldLabel htmlFor="routine-enabled">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{enabled ? "On" : "Paused"}</FieldTitle>
                  <FieldDescription>{enabled ? "Runs on the schedule above." : "Kept, but won't run until you turn it on."}</FieldDescription>
                </FieldContent>
                <Switch id="routine-enabled" checked={enabled} onCheckedChange={setEnabled} aria-label="Routine on or off" />
              </Field>
            </FieldLabel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || Boolean(error)}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
