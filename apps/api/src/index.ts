import { createApp } from "./app.ts";
import { getAuth } from "./auth.ts";
import { apiPort } from "./config.ts";
import { ensureKruDatabase } from "./db/init.ts";
import { startDispatcher } from "./dispatcher.ts";
import { syncSkills } from "./skills.ts";

/**
 * Starts the Kru Bot API: opens the database, applies migrations, prepares
 * login (printing the setup token while no account exists), mirrors the
 * skills library to the box (it lives in the box's container, so a new
 * box starts without it), starts the dispatcher that drives the bots, and
 * listens.
 */
ensureKruDatabase();
await getAuth();
void syncSkills();
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
