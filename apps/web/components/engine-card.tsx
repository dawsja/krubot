"use client";

import { ENGINE_LABELS, ENGINES, PROVIDER_LABELS, isCliEngine, type AiSettings, type BoxStatus, type Engine, type EngineSettings, type ProviderKind, type ProviderMeta } from "@krubot/shared";
import { Check, CircleDashed, LogIn, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { EngineSignInDialog } from "@/components/engine-signin";
import { ModelPicker } from "@/components/model-picker";
import { useProviders } from "@/components/providers-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { patch } from "@/lib/api";

export type Readiness = {
  state: "ready" | "waiting" | "problem";
  text: string;
  /** Set when a sign-in from here would fix it: the engine to sign in to. */
  signIn?: Engine;
};

/** The API an engine runs on: the one it was put on, else the first of its own that has a key. */
export function providerFor(engine: Engine, providers: Record<ProviderKind, ProviderMeta | null> | null, chosen?: ProviderKind | null): ProviderKind {
  const info = ENGINE_LABELS[engine];
  if (chosen && info.providers.includes(chosen)) return chosen;
  return info.providers.find((kind) => providers?.[kind]) ?? info.provider;
}

/**
 * Whether one engine can work right now: a CLI signed in inside your own
 * account on the computer, or a key of yours the API accepted.
 */
export function readiness(engine: Engine, status: BoxStatus | null, providers: Record<ProviderKind, ProviderMeta | null> | null, chosen?: ProviderKind | null): Readiness {
  if (!isCliEngine(engine)) {
    const kind = providerFor(engine, providers, chosen);
    const provider = providers?.[kind];
    if (!providers) return { state: "waiting", text: "Checking…" };
    if (!provider) return { state: "problem", text: "No API key saved yet. Add one below." };
    if (provider.check && !provider.check.ok) return { state: "problem", text: provider.check.detail };
    return { state: "ready", text: `Runs on your ${PROVIDER_LABELS[kind].short} key at ${provider.baseUrl}.` };
  }
  if (!status) return { state: "waiting", text: "Checking the computer…" };
  if (!status.configured || !status.reachable) return { state: "problem", text: "The computer isn't reachable, so the sign-in can't be checked." };
  const notYet: Readiness = { state: "waiting", text: "Not signed in yet.", signIn: engine };
  if (engine === "claude") {
    if (status.claude.status === "ok") return { state: "ready", text: `Signed in${status.claude.email ? ` as ${status.claude.email}` : ""} on the computer.` };
    if (status.claude.status === "missing") return { state: "problem", text: "The computer has no claude CLI. The admin can update it." };
    return notYet;
  }
  const state = status.engines?.[engine as "codex" | "grok"];
  if (!state) return { state: "waiting", text: "Checking the computer…" };
  if (!state.installed) return { state: "problem", text: `The computer has no ${engine} CLI. The admin can update it.` };
  if (state.loggedIn) return { state: "ready", text: "Signed in on the computer." };
  return notYet;
}

/** Whether an engine is ready, in a line, with the way to fix it when it isn't. */
export function ReadinessLine({ value, onSignIn }: { value: Readiness; onSignIn?: (engine: Engine) => void }) {
  const Icon = value.state === "ready" ? Check : value.state === "problem" ? TriangleAlert : CircleDashed;
  return (
    <span className="flex flex-col items-start gap-2">
      <span className={value.state === "problem" ? "flex items-start gap-1.5 text-destructive" : "flex items-start gap-1.5"}>
        <Icon className={value.state === "ready" ? "mt-0.5 size-3.5 shrink-0 text-mint" : "mt-0.5 size-3.5 shrink-0"} aria-hidden="true" />
        <span>{value.text}</span>
      </span>
      {value.signIn && onSignIn ? (
        <Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => onSignIn(value.signIn!)}>
          <LogIn data-icon="inline-start" />
          Sign in to {ENGINE_LABELS[value.signIn].name}
        </Button>
      ) : null}
    </span>
  );
}

/** One engine that is on: what it is, whether it can work, and its sign-in. */
function EngineRow({ engine, ai, status, providers, onSignIn }: { engine: Engine; ai: AiSettings; status: BoxStatus | null; providers: Record<ProviderKind, ProviderMeta | null> | null; onSignIn: (engine: Engine) => void }) {
  const info = ENGINE_LABELS[engine];
  const ready = readiness(engine, status, providers, ai.engines[engine].provider);
  return (
    <li className="flex flex-col gap-1.5 rounded-xl border p-3">
      <span className="flex items-center gap-2 text-[14px] font-medium">
        {info.name}
        {ai.engine === engine ? <span className="rounded-full bg-control px-2 py-0.5 text-[11px] font-medium text-control-foreground">In use</span> : null}
      </span>
      <span className="text-[12.5px] text-muted-foreground">{info.detail}</span>
      <span className="text-[12.5px]">
        <ReadinessLine value={ready} onSignIn={onSignIn} />
      </span>
    </li>
  );
}

/** Settings → AI, yours: the engines you turned on, and the model your bots run. */
export function EngineCard({ ai, status, onChange, onRefresh }: { ai: AiSettings; status: BoxStatus | null; onChange: (next: AiSettings) => void; onRefresh?: () => void }) {
  const { providers } = useProviders();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<Engine | null>(null);

  async function save(next: { engine?: Engine; enabled?: Engine[]; engines?: Partial<Record<Engine, Partial<EngineSettings>>> }) {
    setSaving(true);
    setError(null);
    try {
      const data = await patch<{ ai: AiSettings }>("/api/ai", next);
      onChange(data.ai);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Engine</CardTitle>
        <CardDescription>What does the thinking for your bots. Turn on the ones you have, and their models land in one list below.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field data-disabled={saving || undefined}>
            <FieldTitle>Engines</FieldTitle>
            <ToggleGroup aria-label="Engines" variant="pill" multiple value={ai.enabled} onValueChange={(next) => next.length && void save({ enabled: next as Engine[] })} disabled={saving} className="flex-wrap">
              {ENGINES.map((engine) => (
                <ToggleGroupItem key={engine} value={engine} className="pointer-coarse:min-h-11">
                  {ENGINE_LABELS[engine].name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>Turn on as many as you have. The last one on stays on.</FieldDescription>
          </Field>
          <ul className="flex flex-col gap-2">
            {ai.enabled.map((engine) => (
              <EngineRow key={engine} engine={engine} ai={ai} status={status} providers={providers} onSignIn={setSigningIn} />
            ))}
          </ul>
          <Field data-disabled={saving || undefined}>
            <FieldLabel htmlFor="model">Model</FieldLabel>
            <ModelPicker engine={ai.engine} model={ai.engines[ai.engine].model} disabled={saving} onChange={(next) => void save({ engine: next.engine, engines: { [next.engine]: { model: next.model } } })} />
            <FieldDescription>From the engines above. Picking one puts your bots on that engine.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
      </CardContent>
      <EngineSignInDialog engine={signingIn} onOpenChange={(open) => !open && setSigningIn(null)} onDone={onRefresh} />
    </Card>
  );
}
