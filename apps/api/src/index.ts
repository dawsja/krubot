import { createApp } from "./app.ts";
import { getAuth } from "./auth.ts";
import { apiPort } from "./config.ts";
import { ensureKruDatabase } from "./db/init.ts";
import { startDispatcher } from "./dispatcher.ts";

/**
 * Starts the Kru Bot API: opens the database, applies migrations, prepares
 * login (printing the setup token while no account exists), starts the
 * dispatcher that drives the bots, and listens.
 */
ensureKruDatabase();
await getAuth();
startDispatcher();

const app = createApp();
const server = Bun.serve({
  port: apiPort(),
  hostname: process.env.HOST || "0.0.0.0",
  fetch: app.fetch,
  // Event streams and long turns: never close an idle connection.
  idleTimeout: 0,
});
console.info(`[kru] API listening on http://${server.hostname}:${server.port}`);
