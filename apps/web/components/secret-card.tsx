"use client";

import type { Bot, Message, SecretRequest } from "@krubot/shared";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, post } from "@/lib/api";

/**
 * A bot asked for a secret. The value goes from this masked field straight
 * to the API's store; it never appears in the conversation and the bot
 * only hears that it's there.
 */
export function SecretCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const [request, setRequest] = useState<SecretRequest | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = message.approvalId;

  const load = () => {
    if (!id) return;
    void api<{ request: SecretRequest }>(`/api/secret-requests/${id}`)
      .then((d) => setRequest(d.request))
      .catch(() => undefined);
  };
  useEffect(() => {
    void Promise.resolve().then(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useLiveEvents((event) => {
    if (event.topic === "approvals" || (event.topic === "thread" && event.threadId === message.threadId)) load();
  });

  const [name, ...reasonParts] = message.body.split(": ");
  const reason = reasonParts.join(": ");
  const status = request?.status ?? "pending";
  // A Composio key turns on connected apps rather than being injected somewhere.
  const composio = request?.target === "composio";

  async function answer(event?: FormEvent, decline = false) {
    event?.preventDefault();
    if (!id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ request: SecretRequest }>(`/api/secret-requests/${id}`, decline ? { decline: true } : { value });
      setRequest(data.request);
      setValue("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Bubble variant="outline" className="max-w-[80%]">
      <BubbleContent className="flex flex-col gap-2 border-amber/40 bg-amber/10 p-3">
        <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          <KeyRound className="size-3.5" aria-hidden="true" />
          {bot?.name ?? "A bot"} needs {composio ? "your Composio key" : "a secret"}
        </p>
        <p className="text-[13.5px]">
          <span className={composio ? "font-medium" : "font-mono font-medium"}>{composio ? "Composio API key" : name}</span>
          {reason ? <span className="text-muted-foreground"> · {reason}</span> : null}
        </p>
        {composio && status === "pending" ? (
          <p className="text-[12.5px] text-muted-foreground">
            It connects your apps (Gmail, Slack, Notion and the rest). A free key comes from{" "}
            <a href="https://platform.composio.dev" target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              platform.composio.dev
            </a>{" "}
            under Settings → API keys.
          </p>
        ) : null}
        {status === "pending" ? (
          <form onSubmit={answer} className="flex flex-col gap-2">
            <Field>
              <FieldLabel htmlFor={`secret-${id}`} className="sr-only">
                Value
              </FieldLabel>
              <Input id={`secret-${id}`} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" placeholder="Paste it here; it stays out of the chat" className="max-w-sm" />
            </Field>
            {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy || !value}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Store it
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void answer(undefined, true)}>
                Decline
              </Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground">{composio ? "Stored encrypted by the API and used only when it talks to Composio. The bot never sees the value." : "Stored encrypted by the API and filled in where it’s used. The bot never sees the value."}</p>
          </form>
        ) : (
          <p className="text-[12px] text-muted-foreground">{status === "given" ? (composio ? "Stored. Connected apps are on." : "Stored. The bot was told it's there.") : status === "declined" ? "Declined." : "Nobody answered in time."}</p>
        )}
      </BubbleContent>
    </Bubble>
  );
}
