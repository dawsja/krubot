import { DEFAULT_MODEL, ENGINE_LABELS, PROVIDER_LABELS, type AiSettings, type Engine } from "@krubot/shared";
import type { BoxAccess } from "./box.ts";
import { getProvider, providerProxyToken } from "./data/providers.ts";
import { apiInternalUrl } from "./mcp.ts";
import { isAnthropicHost } from "./routes/llm.ts";

/*
 * What a bot's turn runs on, from its owner's Settings → AI: the engine
 * (the CLI in the box), its model, and how it reaches the model. On the
 * plan, the CLI uses the person's own sign-in inside their account on the
 * box. On an API key, it gets the LLM proxy's URL and the person's
 * provider's proxy token; the key itself stays here.
 */

export type EngineRun = { engine: Engine; model: string; access: BoxAccess };

export class EngineSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineSetupError";
  }
}

export function engineRun(ai: AiSettings, userId: string): EngineRun {
  const engine = ai.engine;
  const config = ai.engines[engine];
  const info = ENGINE_LABELS[engine];
  // Claude Code needs a model; Codex and Grok fall back to their own default.
  const model = config.model || info.defaultModel || (engine === "claude" ? DEFAULT_MODEL : "");
  if (config.access !== "api") return { engine, model, access: { kind: "plan" } };
  const provider = getProvider(userId, info.provider);
  const token = providerProxyToken(userId, info.provider);
  if (!provider || !token) {
    throw new EngineSetupError(`${info.name} is set to run on an API key, but no ${PROVIDER_LABELS[info.provider].name} is saved. Add one under Settings → AI, or switch ${info.name} back to ${info.plan.toLowerCase()}.`);
  }
  return {
    engine,
    model,
    access: {
      kind: "api",
      baseUrl: `${apiInternalUrl()}/api/llm/${info.provider}`,
      token,
      // Claude Code's background model is a Haiku; a provider other than Anthropic may not have one.
      smallModel: engine === "claude" && !isAnthropicHost(provider.baseUrl) ? model : null,
    },
  };
}
