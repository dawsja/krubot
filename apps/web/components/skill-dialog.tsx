"use client";

import { SKILL_LIMITS, type Skill } from "@krubot/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, patch } from "@/lib/api";

/** Write or edit a skill: a name, one line on what it does, and the instructions. */
export function SkillDialog({ skill, onClose, onSaved }: { skill: Skill | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), instructions: instructions.trim() };
      if (skill) await patch(`/api/skills/${skill.id}`, body);
      else await api("/api/skills", { method: "POST", body: JSON.stringify(body) });
      await onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? `Edit /${skill.slug}` : "New skill"}</DialogTitle>
          <DialogDescription>How to do one job, for every bot on the team. Hand it to a bot by typing /{skill?.slug ?? "its-name"} in a message, or run it on a schedule from a routine.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="skill-name">Name</FieldLabel>
              <Input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={SKILL_LIMITS.name} placeholder="Weekly pipeline review" />
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-description">What it does</FieldLabel>
              <Input id="skill-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={SKILL_LIMITS.description} placeholder="One line, shown in the / menu." />
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-instructions">Instructions</FieldLabel>
              <Textarea id="skill-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} required rows={12} maxLength={SKILL_LIMITS.instructions} className="font-mono text-[13px]" placeholder={"# Goal\n\n# Steps\n1. …\n\n# Rules\n- What waits for approval\n- What the result looks like"} />
              <FieldDescription>Markdown. Steps, decision rules, what the result looks like, and what to check with the person first.</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
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
