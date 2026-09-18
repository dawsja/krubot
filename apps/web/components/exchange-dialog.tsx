"use client";

import type { Bot, Message, Thread } from "@krubot/shared";
import { ArrowLeftRight, Lock, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useLiveEvents } from "@/components/hq/live-events";
import { Markdown } from "@/components/markdown";
import { shortTime } from "@/components/sidebar";
import { useStore } from "@/components/store";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Message as MessageRow, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

/*
 * The side conversation behind a "Messaged" or "Message from" line: what
 * two bots said to each other, read-only. You can't write here; you talk
 * to each bot in its own conversation.
 */

type Exchange = { thread: Thread; other: Thread; messages: Message[] };

/** One side of the exchange: the bot behind a conversation, or the room itself. */
function Party({ thread, bot, size = 22 }: { thread: Thread; bot: Bot | undefined; size?: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {bot ? (
        <BotAvatar bot={bot} size={size} />
      ) : (
        <Avatar className="after:hidden" style={{ width: size, height: size }}>
          <AvatarFallback>
            <Users className="size-3" aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
      )}
      <span className="truncate">{bot?.name ?? thread.name}</span>
    </span>
  );
}

export function ExchangeDialog({ threadId, withThreadId, onClose }: { threadId: string; withThreadId: string; onClose: () => void }) {
  const { botById } = useStore();
  const [data, setData] = useState<Exchange | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Exchange>(`/api/threads/${threadId}/exchange?with=${encodeURIComponent(withThreadId)}`));
    } catch {
      setFailed(true);
    }
  }, [threadId, withThreadId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useLiveEvents((event) => {
    if (event.topic === "thread" && (event.threadId === threadId || event.threadId === withThreadId)) void load();
  });

  const mine = data?.thread.botId ? botById(data.thread.botId) : undefined;
  const theirs = data?.other.botId ? botById(data.other.botId) : undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="grid h-[min(85dvh,720px)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="gap-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold">
            {data ? (
              <>
                <Party thread={data.other} bot={theirs} />
                <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Party thread={data.thread} bot={mine} />
              </>
            ) : (
              "Between two bots"
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">What these two bots said to each other. You can read it, not write in it.</DialogDescription>
        </DialogHeader>

        <MessageScrollerProvider autoScroll>
          <MessageScroller className="h-full min-h-0">
            <MessageScrollerViewport className="px-4">
              <MessageScrollerContent className="gap-3 py-4">
                {!data && !failed ? (
                  <MessageScrollerItem className="m-auto">
                    <Spinner />
                  </MessageScrollerItem>
                ) : null}
                {failed || (data && data.messages.length === 0) ? (
                  <MessageScrollerItem className="m-auto">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{failed ? "Couldn't load this." : "Nothing said yet."}</EmptyTitle>
                        <EmptyDescription>{failed ? "One of the conversations is gone." : "What the two bots send each other shows up here."}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                {data?.messages.map((m) => {
                  const author = botById(m.author);
                  return (
                    <MessageScrollerItem key={m.id} messageId={m.id}>
                      <MessageRow align="start" className="items-end">
                        <MessageAvatar className="bg-transparent">{author ? <BotAvatar bot={author} size={24} /> : null}</MessageAvatar>
                        <MessageContent className="gap-1">
                          <MessageHeader style={{ color: author?.color }}>{author?.name ?? "Kru Bot"}</MessageHeader>
                          <Bubble variant="outline" align="start" className="max-w-[92%]">
                            <BubbleContent className="rounded-2xl border-transparent bg-card px-3.5 py-2 shadow-subtle">
                              <Markdown text={m.body} className="flex flex-col gap-2 text-[14px] leading-6" />
                            </BubbleContent>
                          </Bubble>
                          <MessageFooter className="text-[10.5px] font-normal text-ash">{shortTime(m.createdAt)}</MessageFooter>
                        </MessageContent>
                      </MessageRow>
                    </MessageScrollerItem>
                  );
                })}
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>

        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-center gap-3 border-t px-4 py-3 sm:justify-center">
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Lock className="size-3.5" aria-hidden="true" />
            This chat is view-only
          </span>
          <Button size="sm" onClick={onClose}>
            Close chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
