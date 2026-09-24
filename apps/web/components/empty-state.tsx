"use client";

import { BOT_TEMPLATES } from "@krubot/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { KruBot } from "@/components/hq/kru-bot";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The middle pane with nothing open: the lineup and a way to add a bot. */
export function EmptyState({ className }: { className?: string }) {
  const { bots, refresh } = useStore();
  const router = useRouter();
  const [adding, setAdding] = useState<string | null>(null);

  async function add(templateId: string) {
    if (adding) return;
    setAdding(templateId);
    try {
      const { bot } = await post<{ bot: { threadId: string } }>("/api/bots/from-template", { templateId });
      await refresh();
      router.push(`/app/t/${bot.threadId}`);
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className={cn("relative flex flex-1 flex-col overflow-y-auto", className)}>
      <Empty className="m-auto max-w-lg px-6 py-10">
        <EmptyHeader className="max-w-md">
          <EmptyMedia>
            <div className="flex items-end gap-2">
              {(bots.length ? bots.slice(0, 7) : BOT_TEMPLATES.slice(0, 5)).map((b, i) => (
                <KruBot key={i} color={b.color} size={44 + (i % 3) * 8} expression={b.expression} tilt={((i % 3) - 1) * 3} />
              ))}
            </div>
          </EmptyMedia>
          <EmptyTitle className="text-[22px] font-semibold tracking-[-0.4px]">{bots.length ? "Pick a bot to talk to" : "Give work to a bot"}</EmptyTitle>
          <EmptyDescription className="text-[14px] leading-6">Message a bot like a teammate. It works on its own computer and comes back when it needs you.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-lg flex-row flex-wrap justify-center">
          <Button onClick={() => openShellDialog({ kind: "new-bot" })}>
            Create your own
          </Button>
          {BOT_TEMPLATES.filter((t) => !bots.some((b) => b.name === t.name))
            .slice(0, 4)
            .map((t) => (
              <Button key={t.id} variant="outline" onClick={() => void add(t.id)} disabled={Boolean(adding)}>
                {adding === t.id ? <Spinner data-icon="inline-start" /> : <KruBot color={t.color} size={18} expression={t.expression} greet={false} />}
                {adding === t.id ? "Adding…" : `Add ${t.name}`}
              </Button>
            ))}
        </EmptyContent>
      </Empty>
    </div>
  );
}
