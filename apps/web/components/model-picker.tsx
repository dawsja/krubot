"use client";

import { ENGINE_LABELS, type Engine, type ModelChoice, type ModelList } from "@krubot/shared";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

/*
 * Which model a bot runs, across every engine that is turned on. Each
 * engine is asked for its own list: Codex and Grok answer from the CLI in
 * your account on the computer, Claude Code offers its aliases (which
 * follow the newest model of each name), and an API key is asked with the
 * key. Picking a model says which engine runs it, so this is one decision
 * rather than two.
 */

const OTHER = "__other__";

/** A row's value: the engine it belongs to, and the model's id. */
function valueOf(engine: Engine, id: string) {
  return `${engine}:${id}`;
}

/** Typing an id by hand: a field of its own, so switching engine starts it fresh. */
function TypedModel({ value, disabled, onSave, onList }: { value: string; disabled: boolean; onSave: (model: string) => void; onList: (() => void) | null }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <Input
        id="model"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onSave(draft)}
        onKeyDown={(e) => e.key === "Enter" && onSave(draft)}
        placeholder="The model id, as the engine names it"
        autoCapitalize="none"
        spellCheck={false}
        disabled={disabled}
        className="font-mono text-[13px]"
      />
      {onList ? (
        <Button type="button" variant="ghost" size="sm" className="self-start pointer-coarse:min-h-11" onClick={onList}>
          Pick from the list instead
        </Button>
      ) : null}
    </div>
  );
}

export function ModelPicker({
  engine,
  model,
  disabled = false,
  onChange,
}: {
  /** The engine in use; its model is the one shown. */
  engine: Engine;
  model: string;
  disabled?: boolean;
  /** A model, and the engine that runs it. */
  onChange: (next: { engine: Engine; model: string }) => void;
}) {
  const [list, setList] = useState<ModelList | null>(null);
  const [typing, setTyping] = useState(false);

  const load = useCallback(async () => {
    const data = await api<ModelList>("/api/models").catch(() => null);
    setList(data ?? { groups: [] });
  }, []);
  useEffect(() => {
    // Off the effect's own tick, which is what the lint rule wants.
    void Promise.resolve().then(load);
  }, [load]);
  // An engine turned on, or a key saved: a different list.
  useLiveEvents((event) => {
    if (event.topic === "ai") void load();
  });

  if (!list) {
    return (
      <span className="flex h-10 items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner />
        Reading the models…
      </span>
    );
  }

  const groups = list.groups.filter((group) => group.models.length);
  const known = groups.some((group) => group.engine === engine && group.models.some((choice) => choice.id === model));
  // An empty model is the engine's own choice, which Codex and Grok allow.
  const useInput = typing || (model !== "" && !known);
  const save = (next: { engine: Engine; model: string }) => {
    if (next.engine === engine && next.model.trim() === model) return;
    onChange({ engine: next.engine, model: next.model.trim() });
  };

  if (useInput) {
    return (
      <TypedModel
        key={engine}
        value={model}
        disabled={disabled}
        onSave={(id) => save({ engine, model: id })}
        onList={
          groups.length
            ? () => {
                setTyping(false);
                const first = groups[0]!;
                save({ engine: first.engine, model: first.models[0]!.id });
              }
            : null
        }
      />
    );
  }

  const label = (choice: ModelChoice) => choice.name ?? choice.id;
  const items = [
    ...groups.flatMap((group) => group.models.map((choice) => ({ value: valueOf(group.engine, choice.id), label: `${label(choice)} · ${ENGINE_LABELS[group.engine].name}` }))),
    { value: OTHER, label: "Something else…" },
  ];
  const detail = list.groups.find((group) => group.engine === engine)?.detail ?? null;

  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Select
        items={items}
        value={valueOf(engine, model)}
        disabled={disabled}
        onValueChange={(next) => {
          if (!next) return;
          if (next === OTHER) {
            setTyping(true);
            return;
          }
          const at = String(next).indexOf(":");
          save({ engine: String(next).slice(0, at) as Engine, model: String(next).slice(at + 1) });
        }}
      >
        <SelectTrigger id="model" className="w-full max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map((group) => (
            <SelectGroup key={group.engine}>
              {groups.length > 1 ? <SelectLabel>{ENGINE_LABELS[group.engine].name}</SelectLabel> : null}
              {group.models.map((choice) => (
                <SelectItem key={valueOf(group.engine, choice.id)} value={valueOf(group.engine, choice.id)}>
                  {label(choice)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectGroup>
            <SelectItem value={OTHER}>Something else…</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {detail ? <span className="text-[12px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}
