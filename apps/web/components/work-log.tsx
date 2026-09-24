"use client";

import type { Bot, WorkStep } from "@krubot/shared";
import { Check, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { CopyButton } from "@/components/copy-button";
import { useLiveEvents } from "@/components/hq/live-events";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MarkerContent, markerVariants } from "@/components/ui/marker";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/*
 * What a bot is doing, behind its one grey activity line: tap the line and
 * it opens into every step of the turn so far, the commands it ran with
 * what they printed, the files it read or changed, the tools it called,
 * and what it said on the way. Tap a step for its whole command and its
 * output. The API keeps the steps while the turn runs (`/api/threads/:id/
 * work`, then `work` live events), and they go with the line.
 */

/** The steps of each bot working in a conversation, oldest first, kept current. */
export function useWork(threadId: string): Record<string, WorkStep[]> {
  const [work, setWork] = useState<Record<string, WorkStep[]>>({});
  const load = useCallback(async () => {
    const data = await api<{ work: Record<string, WorkStep[]> }>(`/api/threads/${threadId}/work`).catch(() => null);
    if (data) setWork(data.work);
  }, [threadId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "open") void load();
    else if (event.topic === "work" && event.threadId === threadId) {
      const { botId, step } = event;
      setWork((current) => {
        const steps = current[botId] ?? [];
        const at = steps.findIndex((s) => s.id === step.id);
        return { ...current, [botId]: at < 0 ? [...steps, step] : steps.map((s, i) => (i === at ? step : s)) };
      });
    } else if (event.topic === "activity" && event.threadId === threadId && event.line === null) {
      const { botId } = event;
      setWork((current) => {
        if (!(botId in current)) return current;
        const next = { ...current };
        delete next[botId];
        return next;
      });
    }
  });
  return work;
}

function StepIcon({ status }: { status: WorkStep["status"] }) {
  if (status === "running") return <Spinner aria-label="Running" className="size-3.5 text-muted-foreground" />;
  if (status === "failed") return <X aria-label="Failed" className="size-3.5 text-destructive" />;
  return <Check aria-label="Done" className="size-3.5 text-muted-foreground" />;
}

/** One step: its line, and when there is more, the whole command and what it printed. */
function StepRow({ step }: { step: WorkStep }) {
  if (step.kind === "note") {
    return <li className="line-clamp-3 px-2 py-1.5 text-[12.5px] leading-5 whitespace-pre-wrap text-muted-foreground">{step.detail ?? step.title}</li>;
  }
  // The detail is worth showing only when the line cut it short or it is the tool's input.
  const detail = step.detail && step.detail.replace(/\s+/g, " ").trim() !== step.title.replace(/^\$ /, "").trim() ? step.detail : null;
  const more = Boolean(detail || step.output);
  const line = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StepIcon status={step.status} />
      </span>
      <span className={cn("min-w-0 flex-1 truncate font-mono text-[12px]", step.status === "failed" ? "text-destructive" : "text-foreground")}>{step.title}</span>
    </>
  );
  if (!more) return <li className="flex min-h-8 items-center gap-2 px-2 py-1">{line}</li>;
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group/step flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11">
          {line}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/step:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1.5 px-2 pt-1 pb-2">
          {detail ? (
            <pre className="max-h-40 overflow-auto rounded-lg border bg-background px-2.5 py-2 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-foreground select-text wrap-anywhere">
              {step.kind === "command" ? `$ ${detail}` : detail}
            </pre>
          ) : null}
          {step.output ? (
            <div className="group/output relative">
              <pre className="max-h-64 overflow-auto rounded-lg border bg-background px-2.5 py-2 pr-9 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-muted-foreground select-text wrap-anywhere">{step.output}</pre>
              <CopyButton text={step.output} label="Copy output" className="absolute top-1 right-1 size-7 opacity-0 group-hover/output:opacity-100 focus-visible:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-100" />
            </div>
          ) : step.status === "running" ? (
            <p className="px-0.5 text-[11.5px] text-muted-foreground">Still running.</p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * A working bot's line, which opens into its steps. With nothing run yet
 * ("Thinking…") it is just the line.
 */
export function WorkLine({ bot, line, steps }: { bot: Bot | undefined; line: string; steps: WorkStep[] }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const pinned = useRef(true);
  const ran = steps.filter((s) => s.kind !== "note").length;

  // Follow the newest step while the list is scrolled to its end, as a terminal does.
  useLayoutEffect(() => {
    const node = list.current;
    if (open && node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [open, steps]);

  const summary = (
    <>
      {bot ? <BotAvatar bot={bot} size={22} /> : null}
      <MarkerContent className="min-w-0 flex-1 shimmer truncate font-mono text-[12px]">{line}</MarkerContent>
    </>
  );
  if (!steps.length) return <div className={markerVariants()}>{summary}</div>;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Named by what it shows (the line and the count), so voice control finds it; Base UI says whether it is open. */}
      <CollapsibleTrigger className={cn(markerVariants(), "group/work rounded-full py-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11")}>
        {summary}
        <span className="sr-only">, what {bot?.name ?? "the bot"} has done so far</span>
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] tabular-nums">
          {ran ? `${ran} ${ran === 1 ? "step" : "steps"}` : null}
          <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-data-[panel-open]/work:rotate-90" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul
          ref={list}
          onScroll={(e) => {
            const node = e.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
          aria-label={`What ${bot?.name ?? "the bot"} has done so far`}
          className="scroll-fade-y mt-1.5 ml-[30px] flex max-h-[min(24rem,55vh)] flex-col gap-0.5 overflow-y-auto rounded-2xl border border-primary-edge bg-bubble-bot p-1.5 wide:max-w-[78%]"
        >
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
