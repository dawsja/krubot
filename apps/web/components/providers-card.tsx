"use client";

import { PROVIDER_KINDS, PROVIDER_LABELS, type AiSettings, type Engine, type ProviderKind, type ProviderMeta } from "@krubot/shared";
import { Check, KeyRound, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { api, del, patch, post } from "@/lib/api";

/*
 * Your API keys, one per API: Anthropic's, OpenAI's and xAI's, or anything
 * that speaks one of them. Pick the API first and its card opens; that is
 * the only place a key is ever typed, and the only place an engine is put
 * on one, so the Engine card is only ever about your plan. A key is
 * write-only: stored encrypted here, added to your bots' requests on the
 * way out, and never shown again.
 */

/** Whether the person's bots call this API themselves: the API engine is on, and pointed here. */
function runningOn(ai: AiSettings | null | undefined, kind: ProviderKind): boolean {
  return Boolean(ai && ai.enabled.includes("api") && (ai.engines.api.provider ?? null) === kind);
}

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
          <FieldLabel htmlFor={`${kind}-key`}>API key</FieldLabel>
          <Input id={`${kind}-key`} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider ? "Leave empty to keep the saved key" : label.keyHint} autoComplete="off" spellCheck={false} required={!provider} aria-invalid={error ? true : undefined} />
          <FieldDescription>Never shown again once saved.</FieldDescription>
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${kind}-url`}>Base URL</FieldLabel>
          <Input id={`${kind}-url`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} required />
          <FieldDescription>{kind === "anthropic" ? "Without /v1. Claude Code adds it." : "Up to and including /v1, where the API's /models and /chat/completions live."}</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy} className="pointer-coarse:min-h-11">
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? "Saving…" : provider ? "Save" : `Save the ${label.short} key`}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} className="pointer-coarse:min-h-11">
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

/** One saved key: where it points, whether it works, which engines run on it, and the way to change or remove it. */
function SavedKey({ kind, provider, ai, onAiChange, onChange }: { kind: ProviderKind; provider: ProviderMeta; ai?: AiSettings | null; onAiChange?: (next: AiSettings) => void; onChange: () => void }) {
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

  /**
   * Puts the person's bots on this key, or takes them off it. On turns the
   * API engine on and points it here; off leaves the engines they have and
   * moves back to the first of them.
   */
  async function use(on: boolean) {
    if (!ai) return;
    const enabled = on ? [...new Set([...ai.enabled, "api" as Engine])] : ai.enabled.filter((engine) => engine !== "api");
    const body = on
      ? { engine: "api" as Engine, enabled, engines: { api: { provider: kind, access: "api" as const, model: ai.engines.api.model } } }
      : { enabled: enabled.length ? enabled : (["claude"] as Engine[]) };
    const data = await patch<{ ai: AiSettings }>("/api/ai", body).catch(() => null);
    if (data) onAiChange?.(data.ai);
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
            <Badge variant="secondary">Key saved</Badge>
          </span>
          {!editing ? (
            <>
              <code className="mt-1 truncate font-mono text-[12px] text-muted-foreground">{provider.baseUrl}</code>
              <ProviderCheck provider={provider} />
            </>
          ) : null}
        </span>
      </div>
      {!editing && ai ? (
        <FieldGroup className="gap-2 rounded-lg border bg-muted/40 p-3">
          <Field orientation="horizontal" className="min-h-11">
            <FieldLabel htmlFor={`${kind}-run`} className="flex-1 font-normal">
              Run your bots on this key
            </FieldLabel>
            <Switch id={`${kind}-run`} checked={runningOn(ai, kind)} onCheckedChange={(on) => void use(on)} />
          </Field>
          <FieldDescription>Off, they run on the CLIs you turned on.</FieldDescription>
        </FieldGroup>
      ) : null}
      {editing ? (
        <ProviderForm
          kind={kind}
          provider={provider}
          onSaved={() => {
            setEditing(false);
            onChange();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setEditing(true)}>
            Change the key
          </Button>
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={checking} onClick={() => void check()}>
            {checking ? <Spinner data-icon="inline-start" /> : null}
            Check
          </Button>
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11 text-destructive" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
      )}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this API key?</AlertDialogTitle>
            <AlertDialogDescription>Bots running on the {label.short} API stop working until you add a key again or switch them to your plan.</AlertDialogDescription>
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

/**
 * Adding a key: pick which API it is, and that API's card opens under the
 * picker. One field at a time beats three cards asking to be filled in.
 */
export function AddProviderKey({ providers, onSaved }: { providers: Record<ProviderKind, ProviderMeta | null>; onSaved: (kind: ProviderKind) => void }) {
  const missing = PROVIDER_KINDS.filter((kind) => !providers[kind]);
  const [picked, setPicked] = useState<ProviderKind | null>(null);
  // A key saved, here or elsewhere, closes the card it was typed into.
  const kind = picked && !providers[picked] ? picked : null;
  if (!missing.length) return null;

  return (
    <FieldGroup className="gap-3">
      <Field>
        <FieldTitle>Add an API key</FieldTitle>
        <Select items={missing.map((k) => ({ value: k, label: PROVIDER_LABELS[k].name }))} value={kind ?? ""} onValueChange={(value) => value && setPicked(value as ProviderKind)}>
          <SelectTrigger className="w-full max-w-sm" aria-label="Which API">
            <SelectValue placeholder="Which API?" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {missing.map((k) => (
                <SelectItem key={k} value={k}>
                  {PROVIDER_LABELS[k].name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {kind ? <FieldDescription>{PROVIDER_LABELS[kind].detail}</FieldDescription> : null}
      </Field>
      {kind ? (
        <div className="rounded-xl border p-4">
          <ProviderForm
            kind={kind}
            provider={null}
            onSaved={() => {
              setPicked(null);
              onSaved(kind);
            }}
            onCancel={() => setPicked(null)}
          />
        </div>
      ) : null}
    </FieldGroup>
  );
}

/** Settings → AI → API keys. */
export function ProvidersCard({ ai, onAiChange }: { ai?: AiSettings | null; onAiChange?: (next: AiSettings) => void } = {}) {
  const { providers, reload } = useProviders();
  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Run your bots on an API instead of a plan. Kept encrypted here, and never on the computer.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!providers ? (
          <Spinner />
        ) : (
          <>
            {PROVIDER_KINDS.some((kind) => providers[kind]) ? (
              <ul className="flex flex-col gap-3">
                {PROVIDER_KINDS.filter((kind) => providers[kind]).map((kind) => (
                  <SavedKey key={kind} kind={kind} provider={providers[kind]!} ai={ai} onAiChange={onAiChange} onChange={() => void reload()} />
                ))}
              </ul>
            ) : null}
            <AddProviderKey providers={providers} onSaved={() => void reload()} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
