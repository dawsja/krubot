import { approvalDecisionSchema } from "@krubot/shared";
import { Hono } from "hono";
import { ownThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { decide, openApprovals } from "../approvals.ts";
import { getApproval, listApprovals } from "../data/approvals.ts";
import { listThreads } from "../data/threads.ts";

export function approvalsRoutes() {
  const app = new Hono<Env>();

  app.get("/approvals", (c) => {
    const status = c.req.query("status");
    const mine = new Set(listThreads({ userId: userId(c) }).map((t) => t.id));
    if (status === "pending" || !status) return c.json({ approvals: openApprovals().filter((a) => mine.has(a.threadId)) });
    return c.json({ approvals: listApprovals({ limit: Number(c.req.query("limit")) || 100 }).filter((a) => mine.has(a.threadId)) });
  });

  app.get("/approvals/:id", (c) => {
    const approval = getApproval(c.req.param("id"));
    return approval && ownThread(c, approval.threadId) ? c.json({ approval }) : c.json({ error: "No such approval" }, 404);
  });

  app.post("/approvals/:id", async (c) => {
    const parsed = approvalDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Say allow, deny or always" }, 400);
    const asked = getApproval(c.req.param("id"));
    if (!asked || !ownThread(c, asked.threadId)) return c.json({ error: "No such approval" }, 404);
    const approval = decide(c.req.param("id"), parsed.data.decision);
    return approval ? c.json({ approval }) : c.json({ error: "No such approval" }, 404);
  });

  return app;
}
