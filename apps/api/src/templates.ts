import { BOT_TEMPLATES, botInputSchema, type Bot, type BotTemplate } from "@krubot/shared";
import { createBot, listBots } from "./data/bots.ts";
import { createRoutine } from "./data/routines.ts";
import { getSettings } from "./data/settings.ts";
import { postMessage } from "./data/threads.ts";
import { syncSoul } from "./responder.ts";

export function templateById(id: string): BotTemplate | null {
  return BOT_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Adds a teammate from a template, with its routine paused until the person turns it on. */
export async function addFromTemplate(template: BotTemplate, userId: string, options: { toolkits?: string[]; enableRoutine?: boolean } = {}): Promise<Bot> {
  const taken = new Set(listBots({ includeHidden: true, userId }).map((b) => b.name.toLowerCase()));
  let name = template.name;
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${template.name} ${i}`;
  const toolkits = options.toolkits ?? template.toolkits;
  const bot = createBot(
    botInputSchema.parse({
      name,
      title: template.title,
      description: template.description,
      color: template.color,
      expression: template.expression,
      isChief: template.isChief ?? false,
      toolkits,
    }),
    userId,
  );
  if (template.routine) {
    createRoutine(bot.id, { ...template.routine, timezone: getSettings().timezone, enabled: options.enableRoutine ?? false });
  }
  postMessage({
    threadId: bot.threadId,
    author: "system",
    kind: "event",
    body: `${bot.name} joined. ${template.tagline}${template.routine ? ` Routine "${template.routine.name}" is ready under Routines; turn it on when you like.` : ""}`,
    answered: true,
  });
  await syncSoul(bot);
  greet(bot);
  return bot;
}

/** A new bot says hello first: a line from Kru Bot the bot answers, which nobody else sees. */
export function greet(bot: Bot) {
  postMessage({ threadId: bot.threadId, author: "system", kind: "prompt", body: 'The person just created you and opened your conversation for the first time. Greet them in two or three short lines as yourself: who you are, what you take care of, and one good first task to hand you. No headings, no list. This line is from Kru Bot, not the person; answer to the person.'.replace(/'/g, "'") });
}
