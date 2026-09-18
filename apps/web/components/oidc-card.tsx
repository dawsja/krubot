"use client";

import { OIDC_DEFAULT_SCOPES, type OidcSettings } from "@krubot/shared";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api, del, patch } from "@/lib/api";

type Reply = { oidc: OidcSettings; callbackUrl: string };

/**
 * Settings → Authentication → OIDC: the provider people sign in with (Pocket ID,
 * Authentik, Keycloak, anything with discovery). The client secret goes in
 * once and never comes back out; the redirect URL is what to register at
 * the provider.
 */
export function OidcCard() {
  const [state, setState] = useState<Reply | null>(null);
  const [form, setForm] = useState({ name: "", issuer: "", clientId: "", clientSecret: "", scopes: OIDC_DEFAULT_SCOPES });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const data = await api<Reply>("/api/oidc").catch(() => null);
    if (!data) return;
    setState(data);
    setForm((f) => ({ ...f, name: data.oidc.name, issuer: data.oidc.issuer, clientId: data.oidc.clientId, scopes: data.oidc.scopes }));
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await patch<Reply>("/api/oidc", { name: form.name, issuer: form.issuer, clientId: form.clientId, scopes: form.scopes, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) });
      setState(data);
      setForm((f) => ({ ...f, clientSecret: "" }));
      toast.add({ type: "success", title: "Provider saved.", description: data.oidc.enabled ? "The sign-in page shows its button." : "Turn it on when the provider has the redirect URL." });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(on: boolean) {
    try {
      setState(await patch<Reply>("/api/oidc", { enabled: on }));
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not change it." });
    }
  }

  async function forgetSecret() {
    setState(await del<Reply>("/api/oidc/secret"));
    toast.add({ type: "info", title: "Secret forgotten.", description: "The provider is off until a new one is saved." });
  }

  async function copy() {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.callbackUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.add({ type: "error", title: "Couldn't copy. Select the address and copy it yourself." });
    }
  }

  if (!state) return <Skeleton className="h-96 rounded-xl" />;
  const { oidc } = state;
  const ready = Boolean(oidc.issuer && oidc.clientId && oidc.hasClientSecret);

  return (
    <Card>
      <CardHeader>
        <CardTitle>OIDC provider</CardTitle>
        <CardDescription>Let people sign in with your identity provider: Pocket ID, Authentik, Keycloak, Zitadel or any other OpenID Connect provider. Everyone who signs in this way gets their own bots and conversations, and none of these settings.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant={oidc.enabled ? "default" : "outline"}>{oidc.enabled ? "On" : ready ? "Off" : "Not set up"}</Badge>
          <Switch checked={oidc.enabled} disabled={!ready} onCheckedChange={(on) => void toggle(on)} aria-label="Sign in with the provider on or off" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="oidc-callback">Redirect URL</FieldLabel>
          <InputGroup>
            <InputGroupInput id="oidc-callback" readOnly value={state.callbackUrl} className="font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-sm" aria-label="Copy the redirect URL" onClick={() => void copy()}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>Register this as the client&apos;s redirect (callback) URL at the provider. It uses the address in APP_URL, so set that to how people reach Kru Bot.</FieldDescription>
        </Field>
        <form onSubmit={save}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="oidc-name">Provider name</FieldLabel>
              <Input id="oidc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={40} placeholder="Pocket ID" required />
              <FieldDescription>The sign-in page says &ldquo;Sign in with {form.name.trim() || "…"}&rdquo;.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="oidc-issuer">Issuer URL</FieldLabel>
              <Input id="oidc-issuer" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://id.example.com" className="font-mono text-[13px]" required />
              <FieldDescription>Kru Bot reads &lt;issuer&gt;/.well-known/openid-configuration for the endpoints. Pocket ID: the address you open it at. Authentik: https://auth.example.com/application/o/&lt;slug&gt;/.</FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="oidc-client-id">Client id</FieldLabel>
                <Input id="oidc-client-id" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoCapitalize="none" spellCheck={false} className="font-mono text-[13px]" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="oidc-client-secret">Client secret</FieldLabel>
                <Input id="oidc-client-secret" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="off" placeholder={oidc.hasClientSecret ? "Saved. Type a new one to replace it." : ""} required={!oidc.hasClientSecret} />
                <FieldDescription>Kept encrypted; never shown again.</FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="oidc-scopes">Scopes</FieldLabel>
              <Input id="oidc-scopes" value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} autoCapitalize="none" spellCheck={false} className="font-mono text-[13px]" />
              <FieldDescription>Space-separated. The defaults give Kru Bot the person&apos;s name and email.</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Saving…" : "Save provider"}
              </Button>
              {oidc.hasClientSecret ? (
                <Button type="button" variant="ghost" onClick={() => void forgetSecret()}>
                  Forget the secret
                </Button>
              ) : null}
            </div>
          </FieldGroup>
        </form>
        {oidc.enabled ? (
          <Alert>
            <AlertTitle>People from {oidc.name} are users, not admins.</AlertTitle>
            <AlertDescription>They get their own bots and conversations. They see the apps and MCP servers you mark as shared under Apps, and nothing else from Settings. Only this account changes the AI, the computer, the skills, the secrets, or who can sign in.</AlertDescription>
          </Alert>
        ) : null}
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Local sign-in stays</FieldTitle>
            <FieldDescription>The admin account (yours) always signs in with its username and password, so a provider outage never locks you out.</FieldDescription>
          </FieldContent>
        </Field>
      </CardContent>
    </Card>
  );
}
