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

/** The team's shared memory: one file every bot reads each turn and may update. */
export const TEAM_MEMORY_PATH = ".team/MEMORY.md";

/** Most of MEMORY.md that loads into a turn. */
export const MAX_MEMORY_BYTES = 24 * 1024;
export const MAX_MEMORY_LINES = 200;
