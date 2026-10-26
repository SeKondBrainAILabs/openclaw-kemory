import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { memoryAllowed } from "./audience.js";
import { KemoryError } from "./client.js";
import { MEMORY_INSTRUCTION_LINES, renderContext } from "./context.js";
import { createProviderRuntime } from "./provider.js";
import type { PluginDeps } from "./types.js";

const CONTEXT_PATH = "/api/v1/user/context?depth=l3";
const CACHE_TTL_MS = 10 * 60_000;
const SKIP_AFTER_FAILURE_MS = 60_000;
// The host's own hook timeout does not cancel this handler, so the client's
// deadline is what bounds it; the host timeout only has to sit just above it.
const HOST_TIMEOUT_MARGIN_MS = 500;

interface RecallContext {
  agentId?: string;
  sessionKey?: string;
  assertMemoryAudienceCurrent?: () => void;
}

interface CachedContext {
  text: string;
  at: number;
}

/**
 * Registers Kemory as OpenClaw's memory provider and, unless autoRecall is
 * off, loads the user's Kemory context into the system prompt of each owner
 * turn. The capability is registered either way: OpenClaw gives hooks and tools
 * an audience only to a memory slot owner that has a provider runtime.
 */
export function registerRecall(
  api: OpenClawPluginApi,
  deps: PluginDeps,
  opts: { now?: () => number } = {},
): void {
  const { config, client, log } = deps;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CachedContext>();
  let skipUntil = 0;

  if (typeof api.registerMemoryCapability === "function") {
    api.registerMemoryCapability({
      promptBuilder: ({ availableTools }) =>
        availableTools.has("kemory_search") ? [...MEMORY_INSTRUCTION_LINES] : [],
      providerRuntime: createProviderRuntime(deps),
    });
  }
  if (!config.autoRecall) return;

  /** Withholds the text from a turn whose audience was revoked while we worked. */
  function audienceCurrent(ctx: RecallContext): boolean {
    try {
      ctx.assertMemoryAudienceCurrent?.();
      return true;
    } catch {
      return false;
    }
  }

  function reply(ctx: RecallContext, text: string): { appendSystemContext: string } | undefined {
    if (text === "" || !audienceCurrent(ctx)) return undefined;
    return { appendSystemContext: text };
  }

  async function recall(ctx: RecallContext): Promise<{ appendSystemContext: string } | undefined> {
    const key = `${ctx.agentId ?? ""}:${ctx.sessionKey}`;
    // Read before pruning: after a failure the last text is still better than none.
    const previous = cache.get(key);
    const started = now();
    for (const [entryKey, entry] of cache) {
      if (started - entry.at >= CACHE_TTL_MS) cache.delete(entryKey);
    }

    const cached = cache.get(key);
    if (cached) return reply(ctx, cached.text);
    if (started < skipUntil) return undefined;

    let text: string;
    try {
      const res = await client.request("GET", CONTEXT_PATH, { timeoutMs: config.recallTimeoutMs });
      text = renderContext(res.body, {
        maxChars: config.contextMaxChars,
        namespaces: config.contextNamespaces,
      });
    } catch (err) {
      if (err instanceof KemoryError && err.kind === "not_signed_in") {
        log.debug("recall skipped: not signed in");
        return undefined;
      }
      log.failure("recall", err);
      skipUntil = now() + SKIP_AFTER_FAILURE_MS;
      return previous ? reply(ctx, previous.text) : undefined;
    }

    // Revoked mid-request: neither answer nor remember what was fetched for it.
    if (!audienceCurrent(ctx)) return undefined;
    cache.set(key, { text, at: now() });
    return reply(ctx, text);
  }

  api.on(
    "before_prompt_build",
    async (_event, ctx) => {
      try {
        if (!memoryAllowed(ctx) || !ctx.sessionKey) return undefined;
        return await recall(ctx);
      } catch (err) {
        log.failure("recall", err);
        return undefined;
      }
    },
    { timeoutMs: config.recallTimeoutMs + HOST_TIMEOUT_MARGIN_MS },
  );
}
