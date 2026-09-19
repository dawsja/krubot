"use client";

import { APP_CATALOG, BOT_TEMPLATES, ENGINE_LABELS, ENGINES, PROVIDER_LABELS, type AiSettings, type AppCatalogEntry, type BoxStatus, type Engine, type EngineAccess, type EngineSettings } from "@krubot/shared";
import { Check, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppIcon } from "@/components/app-icons";
import { ReadinessLine, readiness } from "@/components/engine-card";
import { ProviderCheck, ProviderForm, useProviders } from "@/components/providers-card";
import { KruBot } from "@/components/hq/kru-bot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";

/*
 * First run: what the person uses every day (which apps their teammates
 * get), who they want on the team, and what the bots run on: Claude Code,
 * Codex or Grok, on the person's plan (signed in on the box) or an API key.
 * Four short steps, all skippable.
 */

type Step = "welcome" | "apps" | "team" | "ai";
const STEPS: Step[] = ["welcome", "apps", "team", "ai"];

const FLOATERS: { color: string; expression: "happy" | "wink" | "surprised" | "sleepy" | "excited"; className: string }[] = [
  { color: "#14B8A6", expression: "happy", className: "left-[8%] top-[18%]" },
  { color: "#EF4444", expression: "wink", className: "left-[34%] top-[8%]" },
  { color: "#3B82F6", expression: "excited", className: "right-[10%] top-[14%]" },
  { color: "#F59E0B", expression: "surprised", className: "right-[22%] bottom-[16%]" },
  { color: "#8B5CF6", expression: "sleepy", className: "left-[16%] bottom-[12%]" },
];

function Floaters() {
  return (
    <>
      {FLOATERS.map((f, i) => (
        <span key={i} className={cn("pointer-events-none absolute hidden opacity-90 sm:block", f.className)} aria-hidden="true">
          <KruBot color={f.color} size={36} expression={f.expression} greet={false} />
        </span>
      ))}
    </>
  );
}

export function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [apps, setApps] = useState<string[]>([]);
  const [templates, setTemplates] = useState<string[]>(["chief-of-staff"]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ai, setAi] = useState<AiSettings | null>(null);
  const { providers, reload: reloadProviders } = useProviders();
  const [modelDraft, setModelDraft] = useState<{ engine: Engine; value: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() =>
      api<{ ai: AiSettings }>("/api/ai")
        .then((d) => alive && setAi(d.ai))
        .catch(() => undefined),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function saveAi(next: { engine?: Engine; engines?: Partial<Record<Engine, Partial<EngineSettings>>> }) {
    try {
      const data = await patch<{ ai: AiSettings }>("/api/ai", next);
      setAi(data.ai);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    }
  }

  // On the AI step, watch the box for a sign-in to land.
  useEffect(() => {
    if (step !== "ai") return;
    let alive = true;
    const check = () =>
      api<{ status: BoxStatus }>("/api/status?fresh=1")
        .then((d) => alive && setStatus(d.status))
        .catch(() => undefined);
    void Promise.resolve().then(check);
    const timer = window.setInterval(check, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step]);

  // The apps Composio can actually connect, with their real logos; the
  // built-in list stands in until the API answers (or without a key).
  const [available, setAvailable] = useState<AppCatalogEntry[]>(APP_CATALOG);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() =>
      api<{ apps: AppCatalogEntry[] }>("/api/catalog")
        .then((d) => alive && d.apps.length && setAvailable(d.apps))
        .catch(() => undefined),
    );
    return () => {
      alive = false;
    };
  }, []);

  const catalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? available.filter((a) => a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)) : available;
  }, [query, available]);

  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/onboarding/complete", { apps, templates, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      router.replace("/app");
      router.refresh();
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not finish setup.");
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10 text-foreground">
      <Floaters />
      <div className="flex w-full max-w-xl flex-col items-center">
        {step === "welcome" ? (
          <>
            <KruBot color="#1DB954" size={120} expression="happy" />
            <h1 className="mt-6 text-center text-[28px] font-semibold tracking-[-0.56px]">Meet your team of bots</h1>
            <p className="mt-3 max-w-md text-center text-[15px] leading-6 text-muted-foreground">
              Every bot has its own computer, its own job and its own memory. Message it like a teammate, give it real work, and it comes back when something needs your approval.
            </p>
          </>
        ) : null}

        {step === "apps" ? (
          <>
            <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">What do you use every day?</h1>
            <p className="mt-2 text-center text-[14px] text-muted-foreground">Your teammates get these apps once you connect them under Settings.</p>
            <InputGroup className="mt-6 max-w-xs rounded-full">
              <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search apps" />
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
            <ToggleGroup multiple variant="outline" aria-label="Apps" value={apps} onValueChange={setApps} className="mt-4 grid max-h-[46vh] w-full grid-cols-2 overflow-y-auto p-1 sm:grid-cols-3">
              {catalog.map((app) => {
                const on = apps.includes(app.toolkit);
                return (
                  <ToggleGroupItem key={app.toolkit} value={app.toolkit} className="h-12 justify-start gap-2.5 rounded-xl bg-card px-3 text-[14px] font-medium hover:border-ash hover:bg-card data-pressed:border-control data-pressed:bg-card data-pressed:ring-1 data-pressed:ring-control aria-pressed:border-control aria-pressed:bg-card aria-pressed:ring-1 aria-pressed:ring-control">
                    <AppIcon toolkit={app.toolkit} logo={app.logo} size={22} />
                    <span className="flex-1 truncate text-left">{app.name}</span>
                    {on ? (
                      <span className="flex size-5 items-center justify-center rounded-full bg-control text-control-foreground">
                        <Check className="size-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </>
        ) : null}

        {step === "team" ? (
          <>
            <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">Meet your first teammates</h1>
            <p className="mt-2 text-center text-[14px] text-muted-foreground">Pick a few to start with. You can create your own, and change any of them, later.</p>
            <FieldGroup className="mt-6 grid max-h-[50vh] grid-cols-1 gap-2 overflow-y-auto p-1 sm:grid-cols-2">
              {BOT_TEMPLATES.map((t) => (
                <FieldLabel key={t.id} htmlFor={`template-${t.id}`} className="bg-card">
                  <Field orientation="horizontal" className="items-start">
                    <KruBot color={t.color} size={40} expression={t.expression} greet={false} />
                    <FieldContent>
                      <FieldTitle>
                        {t.name}
                        {t.isChief ? <Badge variant="secondary">Chief</Badge> : null}
                      </FieldTitle>
                      <FieldDescription className="text-[12.5px] leading-5">{t.tagline}</FieldDescription>
                    </FieldContent>
                    <Checkbox id={`template-${t.id}`} checked={templates.includes(t.id)} onCheckedChange={(on) => setTemplates(on ? [...templates, t.id] : templates.filter((v) => v !== t.id))} className="mt-0.5" />
                  </Field>
                </FieldLabel>
              ))}
            </FieldGroup>
          </>
        ) : null}

        {step === "ai" ? (
          <>
            <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">Choose what your bots run on</h1>
            <p className="mt-2 max-w-md text-center text-[14px] leading-6 text-muted-foreground">Every bot works through a coding agent on its computer. Use your own plan, signed in once in your account on the computer, or an API key that Kru Bot keeps encrypted. Everyone who joins later chooses their own under Settings → AI, and so can you.</p>
            {!ai ? (
              <Spinner className="mt-6" />
            ) : (
              <AiStep
                ai={ai}
                status={status}
                providers={providers}
                modelDraft={modelDraft}
                onModelDraft={setModelDraft}
                onSave={saveAi}
                onProviderSaved={() => void reloadProviders()}
              />
            )}
          </>
        ) : null}

        {error ? <FieldError className="mt-4">{error}</FieldError> : null}

        <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
          {step === "ai" ? (
            <Button size="xl" onClick={() => void finish()} disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? "Setting up…" : "Finish"}
            </Button>
          ) : (
            <Button size="xl" onClick={next}>
              {step === "welcome" ? "Get started" : "Next"}
            </Button>
          )}
          {index > 0 ? (
            <Button variant="secondary" size="xl" onClick={back}>
              Back
            </Button>
          ) : null}
        </div>
        <Progress value={((index + 1) / STEPS.length) * 100} aria-label={`Step ${index + 1} of ${STEPS.length}`} className="mt-6 w-full max-w-xs">
          <span className="w-full text-center text-[12px] text-ash">
            Step {index + 1} of {STEPS.length}
          </span>
        </Progress>
      </div>
    </div>
  );
}

/** The last step: engine, plan or API key, and whether it's ready. */
function AiStep({
  ai,
  status,
  providers,
  modelDraft,
  onModelDraft,
  onSave,
  onProviderSaved,
}: {
  ai: AiSettings;
  status: BoxStatus | null;
  providers: ReturnType<typeof useProviders>["providers"];
  modelDraft: { engine: Engine; value: string } | null;
  onModelDraft: (draft: { engine: Engine; value: string } | null) => void;
  onSave: (next: { engine?: Engine; engines?: Partial<Record<Engine, Partial<EngineSettings>>> }) => Promise<void>;
  onProviderSaved: () => void;
}) {
  const engine = ai.engine;
  const info = ENGINE_LABELS[engine];
  const config = ai.engines[engine];
  const provider = providers?.[info.provider] ?? null;
  const model = modelDraft?.engine === engine ? modelDraft.value : config.model;
  const ready = readiness(engine, config.access, status, providers);
  const saveModel = () => {
    if (model.trim() !== config.model) void onSave({ engines: { [engine]: { model: model.trim() } } }).then(() => onModelDraft(null));
  };

  return (
    <FieldGroup className="mt-6 w-full gap-5">
      <Field>
        <FieldTitle>Engine</FieldTitle>
        <ToggleGroup aria-label="Engine" variant="pill" value={[engine]} onValueChange={(v) => v[0] && v[0] !== engine && void onSave({ engine: v[0] as Engine })} className="flex-wrap">
          {ENGINES.map((e) => (
            <ToggleGroupItem key={e} value={e}>
              {ENGINE_LABELS[e].name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>{info.detail}</FieldDescription>
      </Field>
      <Field>
        <FieldTitle>Runs on</FieldTitle>
        <ToggleGroup aria-label="Runs on" variant="pill" value={[config.access]} onValueChange={(v) => v[0] && v[0] !== config.access && void onSave({ engines: { [engine]: { access: v[0] as EngineAccess } } })} className="flex-wrap">
          <ToggleGroupItem value="plan">{info.plan}</ToggleGroupItem>
          <ToggleGroupItem value="api">An API key</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {config.access === "plan" ? (
        <Alert>
          {ready.state === "ready" ? <Check className="text-mint" /> : ready.state === "waiting" ? <Spinner /> : null}
          <AlertTitle>{ready.state === "ready" ? "Ready." : ready.state === "problem" ? `${info.name} isn't ready yet` : `Sign in to ${info.name} on the computer`}</AlertTitle>
          <AlertDescription>
            {ready.state !== "waiting" ? (
              ready.text
            ) : (
              <>
                After this step, open the computer from the sidebar, start a terminal and run <code className="rounded bg-muted px-1 font-mono text-[13px]">{info.signIn}</code>. Kru Bot never sees the login. This page checks again every few seconds.
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <span className="text-[14px] font-medium">{PROVIDER_LABELS[info.provider].name}</span>
          {provider ? (
            <>
              <code className="truncate font-mono text-[12px] text-muted-foreground">{provider.baseUrl}</code>
              <span className="text-[12.5px]">
                <ProviderCheck provider={provider} />
              </span>
            </>
          ) : (
            <ProviderForm kind={info.provider} provider={null} onSaved={onProviderSaved} />
          )}
        </div>
      )}
      <Field>
        <FieldLabel htmlFor="onboarding-model">Model</FieldLabel>
        <Input id="onboarding-model" value={model} onChange={(e) => onModelDraft({ engine, value: e.target.value })} onBlur={saveModel} onKeyDown={(e) => e.key === "Enter" && saveModel()} placeholder={info.modelHint} autoCapitalize="none" spellCheck={false} className="font-mono text-[13px]" />
        <FieldDescription>{config.access === "api" ? <ReadinessLine value={ready} /> : "A model your plan includes, as the CLI names it."}</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
