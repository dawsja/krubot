"use client";

import type { ComposioKeyStatus } from "@krubot/shared";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, del } from "@/lib/api";

/**
 * Settings → Apps → Composio: your own project key, which your connected
 * apps live in. Write-only like every key: once saved it is never shown
 * again. `onChange` reloads the apps below, since a new key starts over.
 */
export function ComposioCard({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<ComposioKeyStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    const data = await api<ComposioKeyStatus>("/api/composio").catch(() => null);
    if (data) setStatus(data);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<ComposioKeyStatus>("/api/composio", { method: "PUT", body: JSON.stringify({ apiKey: apiKey.trim() }) }));
      setApiKey("");
      setEditing(false);
      toast.add({ type: "success", title: "Composio key saved." });
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await del("/api/composio");
      await load();
      onChange();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not remove the key." });
    } finally {
      setRemoving(false);
    }
  }

  const source = status?.source ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Composio</CardTitle>
        <CardDescription>
          Your apps live in your own Composio project: nobody else sees them. Get a free API key at{" "}
          <a href="https://dashboard.composio.dev" target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-2">
            dashboard.composio.dev
          </a>{" "}
          under Settings → API keys.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!status ? (
          <Spinner />
        ) : source && !editing ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[14px] font-medium">
                API key
                <Badge variant="secondary">{source === "own" ? "Key saved" : "Server's key"}</Badge>
              </span>
              <span className="text-[12.5px] text-muted-foreground">{source === "own" ? "Stored encrypted. It is never shown again, and the bots never see it." : "You're on the key set as COMPOSIO_API_KEY on the server. Add your own to use it instead."}</span>
            </span>
            <span className="flex shrink-0 gap-1">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {source === "own" ? "Replace" : "Add your own"}
              </Button>
              {source === "own" ? (
                <Button variant="destructive" size="sm" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              ) : null}
            </span>
          </div>
        ) : (
          <form onSubmit={save}>
            <FieldGroup className="gap-4">
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="composio-key">API key</FieldLabel>
                <Input id="composio-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ak_…" autoComplete="off" spellCheck={false} required aria-invalid={error ? true : undefined} />
                <FieldDescription>Never shown again once saved. A key for another project drops the apps this one connected.</FieldDescription>
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  {busy ? "Saving…" : "Save"}
                </Button>
                {editing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setApiKey("");
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </FieldGroup>
          </form>
        )}
      </CardContent>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your Composio key?</AlertDialogTitle>
            <AlertDialogDescription>Your bots lose those apps here. They stay in your Composio project.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
