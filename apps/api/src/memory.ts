/** Where a bot's memory lives, relative to the agent's home on the box. Hidden, like .team and .skills. */
export function botHome(botId: string) {
  return `.bots/${botId}`;
}

export function memoryPath(botId: string) {
  return `${botHome(botId)}/MEMORY.md`;
}

export function soulPath(botId: string) {
  return `${botHome(botId)}/SOUL.md`;
}

/** A person's team space: their bots share it, nobody else's read it in their prompts. */
export function teamDir(userId: string) {
  return `.team/${userId}`;
}

/** The team's shared memory: one file each of a person's bots reads every turn and may update. */
export function teamMemoryPath(userId: string) {
  return `${teamDir(userId)}/MEMORY.md`;
}

/** Where the team memory was when one served the whole install; the admin's bots wrote it. */
export const LEGACY_TEAM_MEMORY_PATH = ".team/MEMORY.md";

/** Most of MEMORY.md that loads into a turn. */
export const MAX_MEMORY_BYTES = 24 * 1024;
export const MAX_MEMORY_LINES = 200;
