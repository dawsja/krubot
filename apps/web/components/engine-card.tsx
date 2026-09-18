"use client";

import { CLAUDE_CODE_MODELS, ENGINE_LABELS, ENGINES, MODEL_LABELS, PROVIDER_LABELS, type BoxStatus, type EffortLevel, type Engine, type EngineAccess, type EngineSettings, type ProviderKind, type ProviderMeta, type Settings } from "@krubot/shared";
import { Check, CircleDashed, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { EffortSlider } from "@/components/effort-slider";
import { useProviders } from "@/components/providers-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { patch } from "@/lib/api";

/** What the closed Select shows for each Claude model. */
const MODEL_ITEMS = CLAUDE_CODE_MODELS.map((model) => ({ value: model, label: MODEL_LABELS[model].name }));

export type Readiness = { state: "ready" | "waiting" | "problem"; text: string };

/**
 * Whether the bots can work on this engine and access right now: signed in
 * on the computer for a plan, a working key saved for an API.
 */
export function readiness(engine: Engine, access: EngineAccess, status: BoxStatus | null, providers: Record<ProviderKind, ProviderMeta | null> | null): Readiness {
  const info = ENGINE_LABELS[engine];
  if (access === "api") {
    const provider = providers?.[info.provider];
    if (!providers) return { state: "waiting", text: "Checking…" };
    if (!provider) return { state: "problem", text: `No ${PROVIDER_LABELS[info.provider].name} saved yet. Add it under API keys.` };
    if (provider.check && !provider.check.ok) return { state: "problem", text: provider.check.detail };
    return { state: "ready", text: `Runs on your ${PROVIDER_LABELS[info.provider].name} key at ${provider.baseUrl}.` };
  }
  if (!status) return { state: "waiting", text: "Checking the computer…" };
  if (!status.configured || !status.reachable) return { state: "problem", text: "The computer isn't reachable, so the sign-in can't be checked." };
  if (engine === "claude") {
    if (status.claude.status === "ok") return { state: "ready", text: `Claude Code is signed in${status.claude.email ? ` as ${status.claude.email}` : ""}.` };
    if (status.claude.status === "missing") return { state: "problem", text: "The computer has no claude CLI. Update the computer." };
    return { state: "waiting", text: `Not signed in yet. Open the computer and run ${info.signIn} in a terminal.` };
  }
  const state = status.engines?.[engine];
  if (!state) return { state: "waiting", text: "Checking the computer…" };
  if (!state.installed) return { state: "problem", text: `The computer has no ${engine} CLI. Update the computer.` };
  if (state.loggedIn) return { state: "ready", text: `${info.name} is signed in.` };
  return { state: "waiting", text: `Not signed in yet. Open the computer and run ${info.signIn} in a terminal.` };
}

export function ReadinessLine({ value }: { value: Readiness }) {
  const Icon = value.state === "ready" ? Check : value.state === "problem" ? TriangleAlert : CircleDashed;
  return (
    <span className={value.state === "problem" ? "flex items-start gap-1.5 text-destructive" : "flex items-start gap-1.5"}>
      <Icon className={value.state === "ready" ? "mt-0.5 size-3.5 shrink-0 text-mint" : "mt-0.5 size-3.5 shrink-0"} aria-hidden="true" />
      <span>{value.text}</span>
    </span>
  );
}

/** Settings → AI: which CLI the team runs on, how it reaches its model, and which model. */
export function EngineCard({ settings, status, onChange }: { settings: Settings; status: BoxStatus | null; onChange: (next: Settings) => void }) {
  const { providers } = useProviders();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = settings.engine;
  const info = ENGINE_LABELS[engine];
  const config = settings.engines[engine];
  const [draftModel, setDraftModel] = useState<{ engine: Engine; value: string } | null>(null);
  const model = draftModel?.engine === engine ? draftModel.value : config.model;

  async function save(next: { engine?: Engine; engines?: Partial<Record<Engine, Partial<EngineSettings>>>; effort?: EffortLevel | null }) {
    setSaving(true);
    setError(null);
    try {
      const data = await patch<{ settings: Settings }>("/api/settings", next);
      onChange(data.settings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const saveModel = () => {
    if (model.trim() === config.model) return;
    void save({ engines: { [engine]: { model: model.trim() } } }).then(() => setDraftModel(null));
  };

  const claudePlan = engine === "claude" && config.access === "plan" && (CLAUDE_CODE_MODELS as readonly string[]).includes(config.model);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Engine</CardTitle>
        <CardDescription>The coding agent every bot runs on, on its computer. Switch here and the whole team moves on its next reply; each bot keeps its files and memory, and starts a fresh conversation with the new engine.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field data-disabled={saving || undefined}>
            <FieldTitle>Engine</FieldTitle>
            <ToggleGroup aria-label="Engine" variant="pill" value={[engine]} onValueChange={(v) => v[0] && v[0] !== engine && void save({ engine: v[0] as Engine })} disabled={saving} className="flex-wrap">
              {ENGINES.map((e) => (
                <ToggleGroupItem key={e} value={e}>
                  {ENGINE_LABELS[e].name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{info.detail}</FieldDescription>
          </Field>
          <Field data-disabled={saving || undefined}>
            <FieldTitle>Runs on</FieldTitle>
            <ToggleGroup aria-label="Runs on" variant="pill" value={[config.access]} onValueChange={(v) => v[0] && v[0] !== config.access && void save({ engines: { [engine]: { access: v[0] as EngineAccess } } })} disabled={saving} className="flex-wrap">
              <ToggleGroupItem value="plan">{info.plan}</ToggleGroupItem>
              <ToggleGroupItem value="api">An API key</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              <ReadinessLine value={readiness(engine, config.access, status, providers)} />
            </FieldDescription>
          </Field>
          <Field data-disabled={saving || undefined}>
            <FieldLabel htmlFor="model">Model</FieldLabel>
            {claudePlan ? (
              <Select items={MODEL_ITEMS} value={config.model} onValueChange={(value) => value && void save({ engines: { claude: { model: value } } })} disabled={saving}>
                <SelectTrigger id="model" className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CLAUDE_CODE_MODELS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODEL_LABELS[m].name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <Input id="model" value={model} onChange={(e) => setDraftModel({ engine, value: e.target.value })} onBlur={saveModel} onKeyDown={(e) => e.key === "Enter" && saveModel()} placeholder={info.modelHint} autoCapitalize="none" spellCheck={false} className="max-w-sm font-mono text-[13px]" />
            )}
            <FieldDescription>
              {claudePlan
                ? MODEL_LABELS[config.model as (typeof CLAUDE_CODE_MODELS)[number]].detail
                : config.access === "api"
                  ? engine === "codex"
                    ? "The model id your provider uses. Codex needs a provider that speaks the Responses API, like OpenAI or xAI."
                    : "The model id your provider uses."
                  : "A model your plan includes, as the CLI names it."}
            </FieldDescription>
          </Field>
          <Field data-disabled={saving || undefined}>
            <FieldTitle>Effort</FieldTitle>
            <EffortSlider value={settings.effort} disabled={saving} onChange={(effort) => void save({ effort })} />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
