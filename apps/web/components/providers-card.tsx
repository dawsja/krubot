"use client";

import { PROVIDER_KINDS, PROVIDER_LABELS, type ProviderKind, type ProviderMeta } from "@krubot/shared";
import { Check, KeyRound, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, del, post } from "@/lib/api";

/** The providers the API has, by kind; null until the first answer. */
export function useProviders() {
  const [providers, setProviders] = useState<Record<ProviderKind, ProviderMeta | null> | null>(null);
  const load = useCallback(async () => {
    const data = await api<{ providers: ProviderMeta[] }>("/api/providers").catch(() => null);
    if (!data) return;
    const byKind = Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, data.providers.find((p) => p.kind === kind) ?? null])) as Record<ProviderKind, ProviderMeta | null>;
    setProviders(byKind);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "ai") void load();
  });
  return { providers, reload: load };
}

/**
 * The URL and key of one provider. The key field is write-only: once saved
 * it is never shown again, and leaving it empty on an edit keeps it.
 */
export function ProviderForm({ kind, provider, onSaved, onCancel }: { kind: ProviderKind; provider: ProviderMeta | null; onSaved: (provider: ProviderMeta) => void; onCancel?: () => void }) {
  const label = PROVIDER_LABELS[kind];
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? label.defaultUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ provider: ProviderMeta }>(`/api/providers/${kind}`, { method: "PUT", body: JSON.stringify({ baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) });
      setApiKey("");
      onSaved(data.provider);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${kind}-url`}>Base URL</FieldLabel>
          <Input id={`${kind}-url`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} required />
          <FieldDescription>{kind === "anthropic" ? "Without /v1. Claude Code adds it." : "Up to and including /v1, where the API's /models and /chat/completions live."}</FieldDescription>
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${kind}-key`}>API key</FieldLabel>
          <Input id={`${kind}-key`} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider ? "Leave empty to keep the saved key" : label.keyHint} autoComplete="off" spellCheck={false} required={!provider} aria-invalid={error ? true : undefined} />
          <FieldDescription>Stored encrypted. It is never shown again, and the bots never see it.</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? "Saving…" : "Save"}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  );
}

/** Whether the last check of a provider's key passed, in a line. */
export function ProviderCheck({ provider }: { provider: ProviderMeta }) {
  if (!provider.check) return <span className="text-[12.5px] text-muted-foreground">Not checked yet.</span>;
  return (
    <span className={provider.check.ok ? "flex items-center gap-1.5 text-[12.5px] text-muted-foreground" : "flex items-center gap-1.5 text-[12.5px] text-destructive"}>
      {provider.check.ok ? <Check className="size-3.5 text-mint" aria-hidden="true" /> : <TriangleAlert className="size-3.5" aria-hidden="true" />}
      {provider.check.detail}
    </span>
  );
}

function ProviderRow({ kind, provider, onChange }: { kind: ProviderKind; provider: ProviderMeta | null; onChange: () => void }) {
  const label = PROVIDER_LABELS[kind];
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function check() {
    setChecking(true);
    await post(`/api/providers/${kind}/check`).catch(() => undefined);
    setChecking(false);
    onChange();
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[14px] font-medium">
            {label.name}
            {provider ? <Badge variant="secondary">Key saved</Badge> : null}
          </span>
          <span className="text-[12.5px] text-muted-foreground">{label.detail}</span>
          {provider && !editing ? (
            <>
              <code className="mt-1 truncate font-mono text-[12px] text-muted-foreground">{provider.baseUrl}</code>
              <ProviderCheck provider={provider} />
            </>
          ) : null}
        </span>
        {provider && !editing ? (
          <span className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" disabled={checking} onClick={() => void check()}>
              {checking ? <Spinner data-icon="inline-start" /> : null}
              Check
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </span>
        ) : null}
      </div>
      {!provider || editing ? (
        <ProviderForm
          kind={kind}
          provider={provider}
          onSaved={() => {
            setEditing(false);
            onChange();
          }}
          onCancel={provider ? () => setEditing(false) : undefined}
        />
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this API key?</AlertDialogTitle>
            <AlertDialogDescription>Bots set to use the {label.name.replace(" API", "")} API stop working until you add a key again or switch them to your plan.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void del(`/api/providers/${kind}`).then(onChange)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Settings → AI → API keys. */
export function ProvidersCard() {
  const { providers, reload } = useProviders();
  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Run your bots on an API instead of a plan, or alongside one. Each key is yours alone, stored encrypted in Kru Bot and added to your bots&apos; requests on the way out, so the computer and the bots never hold it.</CardDescription>
      </CardHeader>
      <CardContent>
        {!providers ? (
          <Spinner />
        ) : (
          <ul className="flex flex-col gap-3">
            {PROVIDER_KINDS.map((kind) => (
              <ProviderRow key={kind} kind={kind} provider={providers[kind]} onChange={() => void reload()} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
