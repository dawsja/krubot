"use client";

import { SKILL_LIMITS, type Skill, type SkillFile } from "@krubot/shared";
import { ChevronLeft, Download, FileCode, FilePlus, FileText, Trash2, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del, patch } from "@/lib/api";

function sizeOf(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A file being written or changed: a new one has no `from`. */
type Draft = { from: string | null; path: string; content: string; executable: boolean };

/**
 * Write or edit a skill: SKILL.md (a name, what it does, the instructions)
 * and, once it exists, the files next to it: scripts, references,
 * templates, assets. Files are saved as they are changed; the fields
 * above them with Save.
 */
export function SkillDialog({ skill: initial, onClose, onSaved }: { skill: Skill | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [skill, setSkill] = useState<Skill | null>(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<SkillFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), instructions: instructions.trim() };
      if (skill) {
        await patch(`/api/skills/${skill.id}`, body);
        await onSaved();
        onClose();
      } else {
        // A new skill stays open, so its files can be added next.
        const data = await api<{ skill: Skill }>("/api/skills", { method: "POST", body: JSON.stringify(body) });
        setSkill(data.skill);
        await onSaved();
        toast.add({ type: "success", title: `Saved as /${data.skill.slug}. Add its files below, or close.` });
        setBusy(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  async function openFile(file: SkillFile) {
    if (!skill) return;
    try {
      const data = await api<{ content: string; executable: boolean }>(`/api/skills/${skill.id}/file?path=${encodeURIComponent(file.path)}`);
      setError(null);
      setDraft({ from: file.path, path: file.path, content: data.content, executable: data.executable });
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't open it." });
    }
  }

  async function saveFile(event: FormEvent) {
    event.preventDefault();
    if (!skill || !draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      let next: Skill | null = null;
      // A renamed file moves first, then its words are written at the new path.
      if (draft.from && draft.from !== draft.path.trim()) {
        next = (await patch<{ skill: Skill }>(`/api/skills/${skill.id}/file`, { path: draft.from, to: draft.path.trim() })).skill;
      }
      next = (await api<{ skill: Skill }>(`/api/skills/${skill.id}/file`, { method: "PUT", body: JSON.stringify({ path: draft.path.trim(), content: draft.content, executable: draft.executable }) })).skill;
      setSkill(next);
      setDraft(null);
      await onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the file.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: FileList | null) {
    if (!skill || !files?.length || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("file", file, file.name);
      const data = await api<{ skill: Skill }>(`/api/skills/${skill.id}/files`, { method: "POST", body: form });
      setSkill(data.skill);
      await onSaved();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't add the files." });
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  }

  async function removeFile(file: SkillFile) {
    if (!skill) return;
    try {
      const data = await del<{ skill: Skill }>(`/api/skills/${skill.id}/file?path=${encodeURIComponent(file.path)}`);
      setSkill(data.skill);
      await onSaved();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't delete it." });
    } finally {
      setRemoving(null);
    }
  }

  const title = draft ? (draft.from ? `Edit ${draft.from}` : "New file") : skill ? `Edit /${skill.slug}` : "New skill";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {draft
              ? "A file in the skill's folder. Your bots find it at ~/.skills/" + (skill?.slug ?? "") + "/ and run it from there."
              : `How to do one job, for all of your bots. Hand it to a bot by typing /${skill?.slug ?? "its-name"} in a message, or run it on a schedule from a routine.`}
          </DialogDescription>
        </DialogHeader>

        {draft ? (
          <form onSubmit={saveFile}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="skill-file-path">Path</FieldLabel>
                <Input id="skill-file-path" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} required maxLength={SKILL_LIMITS.path} placeholder="scripts/report.py" className="font-mono text-[13px]" />
                <FieldDescription>Inside the skill&apos;s folder: scripts/ for code, references/ for notes to read, assets/ for templates.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-file-content">Contents</FieldLabel>
                <Textarea id="skill-file-content" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={16} className="font-mono text-[13px]" spellCheck={false} />
              </Field>
              <Field orientation="horizontal">
                <Switch id="skill-file-exec" checked={draft.executable} onCheckedChange={(checked) => setDraft({ ...draft, executable: checked })} />
                <FieldLabel htmlFor="skill-file-exec">Runs on its own</FieldLabel>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => (setDraft(null), setError(null))}>
                  <ChevronLeft data-icon="inline-start" aria-hidden="true" />
                  Back
                </Button>
                <Button type="submit" disabled={busy || !draft.path.trim()}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  {busy ? "Saving…" : "Save file"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="skill-name">Name</FieldLabel>
                <Input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={SKILL_LIMITS.name} placeholder="Weekly pipeline review" />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-description">What it does</FieldLabel>
                <Textarea id="skill-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={SKILL_LIMITS.description} placeholder="What it does and when to use it. Shown in the / menu." />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-instructions">Instructions</FieldLabel>
                <Textarea id="skill-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} required rows={12} maxLength={SKILL_LIMITS.instructions} className="font-mono text-[13px]" placeholder={"# Goal\n\n# Steps\n1. Run scripts/report.py <file>\n\n# Rules\n- What waits for approval\n- What the result looks like"} />
                <FieldDescription>SKILL.md, in Markdown. Steps, decision rules, what the result looks like, what to check with the person first, and how to use each file below.</FieldDescription>
              </Field>

              {skill ? (
                <FieldSet>
                  <FieldLegend variant="label">Files</FieldLegend>
                  <FieldDescription>Saved as you change them. Scripts, references, templates and assets that sit next to SKILL.md.</FieldDescription>
                  {skill.files.length === 0 ? (
                    <Empty className="border py-5">
                      <EmptyHeader>
                        <EmptyTitle>Only SKILL.md so far</EmptyTitle>
                        <EmptyDescription>Add a script or a reference, or upload files.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {skill.files.map((file) => (
                        <li key={file.path} className="group flex items-center gap-2.5 rounded-xl border px-3 py-1.5">
                          {file.text ? <FileCode className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                          {file.text ? (
                            <button type="button" onClick={() => void openFile(file)} className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px] outline-none hover:underline focus-visible:underline">
                              {file.path}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{file.path}</span>
                          )}
                          {file.executable ? <Badge variant="outline">runs</Badge> : null}
                          <span className="shrink-0 text-[11.5px] text-muted-foreground">{sizeOf(file.size)}</span>
                          <Tooltip>
                            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Download ${file.path}`} nativeButton={false} render={<a href={`/api/skills/${skill.id}/file?raw&path=${encodeURIComponent(file.path)}`} download />} />}>
                              <Download aria-hidden="true" />
                            </TooltipTrigger>
                            <TooltipContent>Download</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete ${file.path}`} onClick={() => setRemoving(file)} className="text-destructive" />}>
                              <Trash2 aria-hidden="true" />
                            </TooltipTrigger>
                            <TooltipContent>Delete</TooltipContent>
                          </Tooltip>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => (setError(null), setDraft({ from: null, path: "scripts/", content: "", executable: false }))}>
                      <FilePlus data-icon="inline-start" aria-hidden="true" />
                      New file
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => picker.current?.click()}>
                      {uploading ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" aria-hidden="true" />}
                      Upload files
                    </Button>
                    <input ref={picker} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
                  </div>
                </FieldSet>
              ) : (
                <FieldDescription>Save it first, then add its scripts and files.</FieldDescription>
              )}

              {error ? <FieldError>{error}</FieldError> : null}
              <DialogFooter>
                {skill ? (
                  <Button variant="ghost" className="sm:mr-auto" nativeButton={false} render={<a href={`/api/skills/${skill.id}/download`} download />}>
                    <Download data-icon="inline-start" aria-hidden="true" />
                    Download .skill
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={onClose}>
                  {skill && !initial ? "Done" : "Cancel"}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  {busy ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}

        <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this file?</AlertDialogTitle>
              <AlertDialogDescription>{removing?.path} leaves the skill for every one of your bots.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => removing && void removeFile(removing)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
