import { boardItemClearable, BOARD_COLUMNS, type Board } from "@krubot/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { openApprovals } from "../approvals.ts";
import { BOARD_WINDOW_MS, buildBoard } from "../board.ts";
import { clearBoardItems, clearedBoardItems } from "../data/board.ts";
import { listBots } from "../data/bots.ts";
import { listDelegationsForUser } from "../data/delegations.ts";
import { recentRunsForUser, upcomingRoutines } from "../data/routines.ts";
import { listThreads } from "../data/threads.ts";
import { activeTurns } from "../responder.ts";

/** The signed-in person's board: their bots' work, sorted by what it needs. */
export function boardRoutes() {
  const app = new Hono<Env>();

  /** The person's board as it stands, with what they cleared left off. */
  const boardFor = (me: string): Board => {
    const since = new Date(Date.now() - BOARD_WINDOW_MS).toISOString();
    const threads = new Map(listThreads({ userId: me }).map((t) => [t.id, t]));
    const bots = new Map(listBots({ includeHidden: true, userId: me }).map((b) => [b.id, b]));
    const turns = [...activeTurns().values()]
      .filter((t) => t.userId === me)
      .map((t) => ({ botId: t.botId, threadId: t.threadId, threadName: threads.get(t.threadId)?.name ?? bots.get(t.botId)?.name ?? "Conversation", startedAt: t.startedAt }));
    const board = buildBoard({
      delegations: listDelegationsForUser(me, since),
      approvals: openApprovals().filter((a) => threads.has(a.threadId)),
      turns,
      runs: recentRunsForUser(me, since),
      upcoming: upcomingRoutines(me).flatMap((r) => {
        const bot = bots.get(r.botId);
        return bot ? [{ ...r, threadId: bot.threadId }] : [];
      }),
      cleared: clearedBoardItems(me),
    });
    return board;
  };

  app.get("/board", (c) => c.json(boardFor(userId(c))));

  /** Clears finished cards: the ones named, or every one under Done. Open work stays. */
  app.post("/board/clear", async (c) => {
    const me = userId(c);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.length > 200 || !body.ids.every((id) => typeof id === "string"))) return c.json({ error: "ids must be a list of card ids" }, 400);
    const { columns } = boardFor(me);
    const shown = BOARD_COLUMNS.flatMap((column) => columns[column]).filter(boardItemClearable);
    const wanted = body.ids === undefined ? shown.filter((item) => item.column === "done") : shown.filter((item) => (body.ids as string[]).includes(item.id));
    clearBoardItems(me, wanted.map((item) => item.id));
    return c.json({ cleared: wanted.length });
  });

  return app;
}
