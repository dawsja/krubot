"use client";

import type { Thread } from "@krubot/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { post } from "@/lib/api";

/** A room: several bots and you. Mention a bot to address it; with nobody named, the Chief of Staff answers. */
export function RoomDialog({ onClose }: { onClose: () => void }) {
  const { bots, refresh } = useStore();
  const router = useRouter();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>(bots.filter((b) => b.isChief).map((b) => b.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { thread } = await post<{ thread: Thread }>("/api/rooms", { name: name.trim(), members });
      await refresh();
      router.push(`/app/t/${thread.id}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create the room.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New group chat</DialogTitle>
          <DialogDescription>Put bots in a room so they can coordinate: pass work, assign ownership, and pull you in for judgment calls.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="room-name">Name</FieldLabel>
              <Input id="room-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Launch week" />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Bots</FieldLegend>
              <FieldGroup className="gap-2">
                {bots.map((b) => (
                  <FieldLabel key={b.id} htmlFor={`room-member-${b.id}`}>
                    <Field orientation="horizontal">
                      <Checkbox id={`room-member-${b.id}`} checked={members.includes(b.id)} onCheckedChange={(on) => setMembers(on ? [...members, b.id] : members.filter((m) => m !== b.id))} />
                      <BotAvatar bot={b} size={24} />
                      <FieldContent>
                        <FieldTitle>{b.name}</FieldTitle>
                        {b.title ? <FieldDescription className="truncate">{b.title}</FieldDescription> : null}
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </FieldGroup>
            </FieldSet>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || members.length === 0}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Creating…" : "Create room"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
