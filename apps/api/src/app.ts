import { Hono } from "hono";
import type { Session } from "./auth.ts";
import { requireAdmin, userId } from "./access.ts";
import { countAccounts, getAuth, getSession, isSameOrigin, registerAccount } from "./auth.ts";
import { AVATAR_MAX_BYTES, clearAvatar, getAvatar, getUser, setAvatar } from "./data/users.ts";
import { approvalsRoutes } from "./routes/approvals.ts";
import { botsRoutes } from "./routes/bots.ts";
import { boxRoutes } from "./routes/box.ts";
import { connectionsRoutes } from "./routes/connections.ts";
import { eventsRoutes } from "./routes/events.ts";
import { llmProxyRoutes, providerRoutes } from "./routes/llm.ts";
import { mcpProxyRoutes, mcpRoutes } from "./routes/mcp.ts";
import { pushRoutes } from "./routes/push.ts";
import { secretsRoutes } from "./routes/secrets.ts";
import { skillsRoutes } from "./routes/skills.ts";
import { routinesRoutes } from "./routes/routines.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { threadsRoutes } from "./routes/threads.ts";
import { authConfig, usersRoutes } from "./routes/users.ts";

export type Env = { Variables: { session: Session } };

/**
 * The API. Everything under /api needs a signed-in person, except the auth
 * routes, registration, the sign-in page's view of the auth setup, and
 * the health check. Unsafe methods must be same-origin. Server-wide
 * settings (the AI, the computer, the skills, who may sign in) are the
 * admin's; bots, conversations, connected apps, MCP servers and secrets
 * are each person's own, the admin's included.
 */
export function createApp() {
  const app = new Hono<Env>();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const auth = await getAuth();
    return auth.handler(c.req.raw);
  });

  app.get("/api/account", async (c) => c.json({ accounts: await countAccounts() }));

  // What the sign-in page needs: whether the local account exists, and the provider's button.
  app.get("/api/auth-config", async (c) => c.json(authConfig((await countAccounts()) > 0)));

  app.post("/api/register", async (c) => {
    if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-site request blocked" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; username?: string; password?: string; confirm?: string };
    if (body.password !== body.confirm) return c.json({ error: "The passwords don't match." }, 400);
    const result = await registerAccount({ token: String(body.token ?? ""), username: String(body.username ?? ""), password: String(body.password ?? "") }, c.req.raw.headers);
    if (result.error) return c.json(result, 400);
    // Sign the new account in: the sign-up call set no cookie on our response.
    const auth = await getAuth();
    const signIn = await auth.api.signInUsername({ body: { username: String(body.username).trim().toLowerCase(), password: String(body.password) }, headers: c.req.raw.headers, asResponse: true });
    return signIn;
  });

  // The MCP and LLM proxies are for the box, with their own tokens, not a session.
  app.route("/api", mcpProxyRoutes());
  app.route("/api", llmProxyRoutes());

  app.use("/api/*", async (c, next) => {
    if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-site request blocked" }, 403);
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: "Sign in to continue" }, 401);
    c.set("session", session);
    await next();
  });

  // The admin's areas. Reads that everyone needs (the skills index, a
  // reduced settings view) stay open and are narrowed inside their routes.
  // Connected apps, MCP servers and secrets are each person's own and
  // answer only for the signed-in person.
  for (const path of ["/api/box", "/api/box/*", "/api/status", "/api/onboarding/*", "/api/providers", "/api/providers/*", "/api/users", "/api/users/*", "/api/oidc", "/api/oidc/*", "/api/bots/:id/files"]) {
    app.use(path, requireAdmin);
  }
  app.on(["POST", "PATCH", "PUT", "DELETE"], ["/api/settings", "/api/skills", "/api/skills/*"], requireAdmin);

  app.get("/api/me", (c) => {
    const session = c.get("session");
    const user = getUser(session.user.id);
    return user ? c.json({ user }) : c.json({ error: "Sign in to continue" }, 401);
  });

  // Your profile picture, kept in the database and shown in the sidebar and on your messages.
  app.get("/api/me/avatar", (c) => {
    const avatar = getAvatar(userId(c));
    if (!avatar) return c.json({ error: "No picture" }, 404);
    return new Response(Buffer.from(avatar.data), {
      headers: { "Content-Type": avatar.mediaType, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  });

  app.put("/api/me/avatar", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Send the picture as a file" }, 400);
    if (file.size > AVATAR_MAX_BYTES) return c.json({ error: "The picture must be under 2 MB" }, 413);
    try {
      const avatar = setAvatar(userId(c), { mediaType: file.type, data: new Uint8Array(await file.arrayBuffer()) });
      return c.json({ avatar });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save the picture" }, 400);
    }
  });

  app.delete("/api/me/avatar", (c) => {
    clearAvatar(userId(c));
    return c.body(null, 204);
  });

  app.route("/api", botsRoutes());
  app.route("/api", threadsRoutes());
  app.route("/api", approvalsRoutes());
  app.route("/api", routinesRoutes());
  app.route("/api", settingsRoutes());
  app.route("/api", connectionsRoutes());
  app.route("/api", boxRoutes());
  app.route("/api", eventsRoutes());
  app.route("/api", skillsRoutes());
  app.route("/api", mcpRoutes());
  app.route("/api", secretsRoutes());
  app.route("/api", providerRoutes());
  app.route("/api", pushRoutes());
  app.route("/api", usersRoutes());

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("[kru]", error);
    return c.json({ error: error.message || "Something went wrong" }, 500);
  });
  return app;
}
