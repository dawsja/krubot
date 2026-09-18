import { oidcPatchSchema, type AuthConfig } from "@krubot/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { getAuth, invalidateAuth, oidcCallbackUrl, oidcLogoutUrl } from "../auth.ts";
import { boxConfig, deleteBotHome } from "../box.ts";
import { clearOidcSecret, getOidcSettings, oidcReady, updateOidcSettings } from "../data/oidc.ts";
import { listThreads } from "../data/threads.ts";
import { deleteUserData, getUser, listUsers } from "../data/users.ts";
import { interrupt } from "../responder.ts";

/*
 * Settings → Authentication, the admin's: the OIDC provider people sign in with,
 * and the people who have. Everything here is behind requireAdmin (see
 * app.ts) except the public sign-in page's view of it, /auth-config.
 */

/** What the sign-in page shows: the local account exists, and the provider's button when it is set up. */
export function authConfig(local: boolean): AuthConfig {
  const oidc = getOidcSettings();
  return { local, oidc: oidcReady() ? { enabled: true, name: oidc.name } : null };
}

export function usersRoutes() {
  const app = new Hono<Env>();

  app.get("/oidc", (c) => c.json({ oidc: getOidcSettings(), callbackUrl: oidcCallbackUrl(), logoutUrl: oidcLogoutUrl() }));

  app.patch("/oidc", async (c) => {
    const parsed = oidcPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad settings" }, 400);
    if (parsed.data.issuer && !/^https?:\/\//.test(parsed.data.issuer)) return c.json({ error: "The issuer is an https:// address" }, 400);
    const oidc = updateOidcSettings(parsed.data);
    if (oidc.enabled && (!oidc.issuer || !oidc.clientId || !oidc.hasClientSecret)) {
      updateOidcSettings({ enabled: false });
      return c.json({ error: "To turn it on, give the issuer, the client id and the client secret" }, 400);
    }
    // The provider list is fixed when Better Auth is made; the next request gets a new instance.
    invalidateAuth();
    return c.json({ oidc: getOidcSettings(), callbackUrl: oidcCallbackUrl(), logoutUrl: oidcLogoutUrl() });
  });

  /** Forgets the client secret and turns the provider off. */
  app.delete("/oidc/secret", (c) => {
    const oidc = clearOidcSecret();
    invalidateAuth();
    return c.json({ oidc, callbackUrl: oidcCallbackUrl(), logoutUrl: oidcLogoutUrl() });
  });

  app.get("/users", (c) => c.json({ users: listUsers() }));

  /** Removes a person and everything of theirs: bots (and their homes on the computer), conversations, sessions. */
  app.delete("/users/:id", async (c) => {
    const id = c.req.param("id");
    if (id === userId(c)) return c.json({ error: "You can't remove yourself" }, 400);
    const user = getUser(id);
    if (!user) return c.json({ error: "No such person" }, 404);
    if (user.role === "admin") return c.json({ error: "The admin can't be removed" }, 400);
    for (const thread of listThreads({ userId: id })) await interrupt(thread.id).catch(() => undefined);
    const { bots } = deleteUserData(id);
    const box = boxConfig();
    for (const botId of bots) if (box) await deleteBotHome(box, botId).catch(() => undefined);
    const auth = await getAuth();
    await auth.api.removeUser({ body: { userId: id }, headers: c.req.raw.headers });
    return c.body(null, 204);
  });

  return app;
}
