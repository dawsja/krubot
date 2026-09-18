"use client";

import { APPROVAL_LEVELS, APPROVAL_LEVEL_LABELS, BOT_COLORS, BOT_EXPRESSIONS, BOT_LIMITS, BOT_TEMPLATES, type Bot, type BotExpression, type Connection, type McpServer, mcpToolkit } from "@krubot/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { appName, AppIcon, McpIcon } from "@/components/app-icons";
import { KruBot } from "@/components/hq/kru-bot";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, patch, post } from "@/lib/api";

type Form = {
  name: string;
  title: string;
  description: string;
  color: string;
  expression: BotExpression;
  approval: (typeof APPROVAL_LEVELS)[number];
  toolkits: string[];
  notify: boolean;
};

const APPROVAL_ITEMS = APPROVAL_LEVELS.map((level) => ({ value: level, label: APPROVAL_LEVEL_LABELS[level].title }));
const TEMPLATE_ITEMS = [{ value: "", label: "A blank bot" }, ...BOT_TEMPLATES.map((t) => ({ value: t.id, label: t.name }))];

const EMPTY: Form = { name: "", title: "", description: "", color: BOT_COLORS[0], expression: "happy", approval: "ask", toolkits: [], notify: true };

/** Create or edit a bot: its name, job, how it works, how it looks, and what it may do. */
export function BotDialog({ botId, onClose }: { botId: string | null; onClose: () => void }) {
  const { bots, refresh } = useStore();
  const router = useRouter();
  const existing = botId ? bots.find((b) => b.id === botId) ?? null : null;
  const [form, setForm] = useState<Form>(existing ? pick(existing) : EMPTY);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!existing) api<{ name: string }>("/api/bots/name").then((d) => setForm((f) => (f.name ? f : { ...f, name: d.name, color: BOT_COLORS[bots.length % BOT_COLORS.length]! }))).catch(() => undefined);
    api<{ connections: Connection[] }>("/api/connections").then((d) => setConnections(d.connections)).catch(() => undefined);
    api<{ servers: McpServer[] }>("/api/mcp-servers").then((d) => setServers(d.servers)).catch(() => undefined);
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyTemplate(id: string) {
    setTemplate(id);
    const t = BOT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setForm((f) => ({ ...f, name: f.name || t.name, title: t.title, description: t.description, color: t.color, expression: t.expression, toolkits: t.toolkits }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await patch(`/api/bots/${existing.id}`, form);
        await refresh();
      } else {
        // A template that is a Chief of Staff makes one; otherwise a bot becomes
        // the Chief when you tell it so in conversation.
        const isChief = BOT_TEMPLATES.find((t) => t.id === template)?.isChief ?? false;
        const { bot } = await post<{ bot: Bot }>("/api/bots", { ...form, isChief });
        await refresh();
        router.push(`/app/t/${bot.threadId}`);
      }
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : "Create a bot"}</DialogTitle>
          <DialogDescription>A bot has a name, a job, and a way of working. Focused bots build more useful context than one catch-all bot.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-5">
            <div className="flex items-start gap-4">
              <div className="flex w-44 shrink-0 flex-col items-center gap-2">
                <KruBot color={form.color} size={88} expression={form.expression} />
                {/* The colour swatches are radios drawn as dots. */}
                <RadioGroup aria-label="Color" value={form.color} onValueChange={(value) => typeof value === "string" && set("color", value)} className="flex w-auto flex-wrap justify-center gap-1">
                  {BOT_COLORS.map((c) => (
                    <RadioGroupItem key={c} value={c} aria-label={c} className="size-5 border-2 border-transparent bg-(--swatch) ring-primary ring-offset-2 ring-offset-card data-checked:border-transparent data-checked:bg-(--swatch) data-checked:ring-2 dark:bg-(--swatch) dark:data-checked:bg-(--swatch) [&>span]:hidden" style={{ "--swatch": c } as React.CSSProperties} />
                  ))}
                </RadioGroup>
                <ToggleGroup aria-label="Expression" variant="pill" size="sm" value={[form.expression]} onValueChange={(v) => v[0] && set("expression", v[0] as BotExpression)} spacing={1} className="flex-wrap justify-center">
                  {BOT_EXPRESSIONS.map((e) => (
                    <ToggleGroupItem key={e} value={e} className="h-6 px-2 text-[11px]">
                      {e}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <FieldGroup className="gap-3">
                {!existing ? (
                  <Field>
                    <FieldLabel htmlFor="bot-template">Start from</FieldLabel>
                    <Select items={TEMPLATE_ITEMS} value={template} onValueChange={(value) => applyTemplate(value ?? "")}>
                      <SelectTrigger id="bot-template" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {TEMPLATE_ITEMS.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="bot-name">Name</FieldLabel>
                  <Input id="bot-name" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={BOT_LIMITS.name} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bot-title">Job</FieldLabel>
                  <Input id="bot-title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={BOT_LIMITS.title} placeholder="Sales Outbound, Inbox Manager, Chief of Staff…" />
                </Field>
              </FieldGroup>
            </div>

            <Field>
              <FieldLabel htmlFor="bot-description">How it should work</FieldLabel>
              <Textarea id="bot-description" value={form.description} onChange={(e) => set("description", e.target.value)} rows={5} maxLength={BOT_LIMITS.description} placeholder="What it owns, which sources it uses, what it must avoid or ask before doing, and what it returns. This becomes its SOUL.md." />
            </Field>
            <Field>
              <FieldLabel htmlFor="bot-approval">Approvals</FieldLabel>
              <Select items={APPROVAL_ITEMS} value={form.approval} onValueChange={(value) => value && set("approval", value as Form["approval"])}>
                <SelectTrigger id="bot-approval" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {APPROVAL_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {APPROVAL_LEVEL_LABELS[level].title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{APPROVAL_LEVEL_LABELS[form.approval].detail} Every bot runs on the model chosen under Settings. To make a bot your Chief of Staff, just tell it so in its conversation.</FieldDescription>
            </Field>

            <FieldSet>
              <FieldLegend variant="label">Connected apps this bot may use</FieldLegend>
              {connections.length === 0 && servers.length === 0 ? (
                <FieldDescription>No apps connected yet. Add your Composio key and connect Gmail, Slack, GitHub and more under Settings → Apps, or add your own MCP server there.</FieldDescription>
              ) : (
                <ToggleGroup multiple variant="pill" size="sm" value={form.toolkits} onValueChange={(v) => set("toolkits", v)} className="flex-wrap">
                  {connections.map((c) => (
                    <ToggleGroupItem key={c.toolkit} value={c.toolkit}>
                      <AppIcon toolkit={c.toolkit} size={14} />
                      {appName(c.toolkit)}
                    </ToggleGroupItem>
                  ))}
                  {servers.map((server) => (
                    <ToggleGroupItem key={server.id} value={mcpToolkit(server.id)} title={server.url ?? server.command}>
                      <McpIcon id={server.id} transport={server.transport} size={14} />
                      {server.name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </FieldSet>

            <FieldLabel htmlFor="bot-notify">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Notify me</FieldTitle>
                  <FieldDescription>A browser notification when it finishes a job for you or needs your input. Turn notifications on under Settings first.</FieldDescription>
                </FieldContent>
                <Switch id="bot-notify" checked={form.notify} onCheckedChange={(on) => set("notify", on)} aria-label="Notify me" />
              </Field>
            </FieldLabel>

            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Saving…" : existing ? "Save" : "Create bot"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function pick(bot: Bot): Form {
  return { name: bot.name, title: bot.title, description: bot.description, color: bot.color, expression: bot.expression, approval: bot.approval, toolkits: bot.toolkits, notify: bot.notify };
}
