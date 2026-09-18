"use client";

import { SECRET_NAME, type SecretMeta } from "@krubot/shared";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del } from "@/lib/api";

/** Settings → Secrets: names only; a value goes in once and is never shown again. */
export function SecretsCard() {
  const { bots } = useStore();
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SecretMeta | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ secrets: SecretMeta[] }>("/api/secrets").catch(() => null);
    if (data) setSecrets(data.secrets);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!SECRET_NAME.test(name)) return setError("Name it in UPPER_SNAKE_CASE, like STRIPE_API_KEY.");
    setBusy(true);
    setError(null);
    try {
      await api(`/api/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      setName("");
      setValue("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          Keys and tokens the bots use but never see. A bot asks for one with a card in its conversation; you type it into a masked field here or there; Kru stores it encrypted and fills it in where it&apos;s used, such as an MCP server&apos;s headers as {"{{secret:NAME}}"}. Anything a bot writes is scrubbed of these values. Passwords, one-time codes and payments are different: take over the computer and type those yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!secrets ? (
          <Spinner />
        ) : secrets.length === 0 ? (
          <Empty className="border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound />
              </EmptyMedia>
              <EmptyTitle>No secrets stored</EmptyTitle>
              <EmptyDescription>Add one below, or wait for a bot to ask.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {secrets.map((secret) => {
              const bot = secret.requestedBy ? bots.find((b) => b.id === secret.requestedBy) : null;
              return (
                <li key={secret.name} className="group flex items-center gap-3 rounded-xl border px-3 py-2">
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-[13.5px] font-medium">{secret.name}</span>
                    <span className="ml-2 text-[12px] text-muted-foreground">{bot ? `asked for by ${bot.name}` : "added by you"} · {new Date(secret.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <Badge variant="secondary">••••••••</Badge>
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Delete ${secret.name}`} onClick={() => setRemoving(secret)} className="text-destructive opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100" />}>
                      <Trash2 aria-hidden="true" />
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
        <form onSubmit={add}>
          <FieldGroup className="gap-3 sm:grid sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="secret-name">Name</FieldLabel>
              <Input id="secret-name" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="STRIPE_API_KEY" autoComplete="off" spellCheck={false} className="font-mono" />
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-value">Value</FieldLabel>
              <Input id="secret-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" placeholder="Pasted once, never shown" />
            </Field>
            <Button type="submit" variant="outline" disabled={busy || !name || !value}>
              {busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
              Add
            </Button>
            {error ? <FieldError className="sm:col-span-3">{error}</FieldError> : null}
          </FieldGroup>
        </form>
      </CardContent>

      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Anything that fills it in stops working until it&apos;s added again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void del(`/api/secrets/${encodeURIComponent(removing.name)}`).then(load).finally(() => setRemoving(null))}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
