"use client";

import { Confirm } from "@/components/confirm-dialog";
import { useStore } from "@/components/store";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";

/** How many of your conversations have a bot working in them right now. */
export function useWorkingCount(): number {
  const { threads, activity } = useStore();
  const working = new Set(threads.filter((t) => t.busy).map((t) => t.id));
  for (const [threadId, bots] of Object.entries(activity)) if (Object.keys(bots).length) working.add(threadId);
  return working.size;
}

/**
 * Stop all: every bot of yours stops, and so does everything they set
 * going (handoffs, messages to each other, follow-ups), so nothing starts
 * again until you write.
 */
export function StopAllConfirm({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { refresh } = useStore();
  async function stopAll() {
    try {
      const { stopped } = await post<{ stopped: number }>("/api/stop");
      toast.add({ type: "success", title: stopped ? `Stopped ${stopped} bot${stopped === 1 ? "" : "s"}.` : "Nothing was running." });
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not stop them." });
    }
    await refresh();
  }
  return (
    <Confirm
      open={open}
      onOpenChange={onOpenChange}
      title="Stop all your bots?"
      description="Everything they're working on stops, with the tasks they handed each other and their follow-ups. Messages waiting for them are dropped."
      action="Stop all"
      onConfirm={() => void stopAll()}
    />
  );
}
