import { DEFAULT_MODEL, ENGINE_LABELS, PROVIDER_LABELS, isCliEngine, type AiSettings, type Engine, type ProviderKind } from "@krubot/shared";
import type { BoxAccess } from "./box.ts";
import { getProvider, providerProxyToken } from "./data/providers.ts";
import { apiInternalUrl } from "./mcp.ts";
import type { NativeAccess } from "./native.ts";
import { isAnthropicHost } from "./routes/llm.ts";

/*
 * What a bot's turn runs on, from its owner's Settings → AI: the engine,
 * its model, and how it reaches the model. A CLI runs in the box on the
 * person's own plan, signed in inside their account there. The API engine
 * runs here instead, against their own key, and the box is only its
 * computer.
 */

export type EngineRun = { engine: Engine; model: string; access: BoxAccess; native?: NativeAccess };

/** The API an engine's key is: the one it was put on, else the first of its own that has a key. */
export function providerFor(engine: Engine, userId: string): ProviderKind {
  const info = ENGINE_LABELS[engine];
  return info.providers.find((kind) => getProvider(userId, kind)) ?? info.provider;
}

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
  // The API engine is answered here, not in the box: Kru Bot makes the call itself.
  if (!isCliEngine(engine)) {
    const kind = config.provider ?? providerFor(engine, userId);
    const token = providerProxyToken(userId, kind);
    if (!getProvider(userId, kind) || !token) {
      throw new EngineSetupError("Your bots are set to call an API directly, but no key is saved. Add one under Settings → AI → API keys and switch your bots onto it.");
    }
    if (!model) throw new EngineSetupError(`Pick a model for the ${PROVIDER_LABELS[kind].short} API under Settings → AI. Calling an API directly needs one; there is no default.`);
    // Through Kru's own proxy, like a CLI's: only the proxy holds the key.
    return { engine, model, access: { kind: "plan" }, native: { kind, baseUrl: `${apiInternalUrl()}/api/llm/${kind}`, token } };
  }
  /*
   * A CLI runs on the person's own plan, signed in inside their account on
   * the computer. It used to be able to run on a key through the proxy
   * too, which left it showing the API engine's line with no way back; a
   * key is the API engine's job now, and it needs no CLI at all.
   */
  return { engine, model, access: { kind: "plan" } };
}
