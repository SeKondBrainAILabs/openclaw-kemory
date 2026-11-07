import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { memoryAllowed } from "../audience.js";
import { KemoryError } from "../client.js";
import type { PluginDeps } from "../types.js";
import { type CaptureWhen, planCapture } from "./plan.js";
import { extractUserPrompts } from "./prompts.js";
import { readState, statePath, writeState } from "./state.js";

const MEMORIES_PATH = "/api/v1/memories";
// The host's hook timeout does not cancel a handler, so the client deadline is
// what bounds each capture; the host timeout only has to sit just above it.
const HOST_TIMEOUT_MARGIN_MS = 2000;

/** The owner's prompts from the last gated turn of one session, waiting to be flushed. */
interface PendingCapture {
  agentId: string;
  sessionKey: string;
  sessionId: string | undefined;
  channel: string;
  prompts: string[];
}

interface CaptureRequest {
  kind: "incremental" | "flush";
  when: CaptureWhen;
  endReason: string;
}

function pendingKey(agentId: string | undefined, sessionKey: string): string {
  return `${agentId ?? ""}:${sessionKey}`;
}

/**
 * Saves the owner's prompts to Kemory after each successful turn, and flushes whatever is
 * still unsent when a session compacts or ends and when the gateway stops. Nothing is
 * buffered unless a turn passed memoryAllowed, and extractUserPrompts keeps only the
 * messages OpenClaw marks as the owner's, so the flushes (whose host contexts carry no
 * audience) can only send prompts that were already cleared.
 */
export function registerCapture(api: OpenClawPluginApi, deps: PluginDeps): void {
  const { config, client, log } = deps;
  if (!config.autoCapture) return;

  const pending = new Map<string, PendingCapture>();
  // One chain per session, so captures for it run one at a time and a second one sees the
  // mark the first one wrote.
  const chains = new Map<string, Promise<void>>();

  async function capture(entry: PendingCapture, request: CaptureRequest): Promise<void> {
    try {
      const path = statePath(deps.home, entry.agentId, entry.sessionKey);
      const plan = planCapture({
        prompts: entry.prompts,
        state: await readState(path),
        kind: request.kind,
        when: request.when,
        channel: entry.channel,
      });
      if (!plan) return;

      await client.request("POST", MEMORIES_PATH, {
        body: {
          namespace: config.captureNamespace,
          namespace_tag: "session-capture",
          visibility: config.captureVisibility,
          content: plan.content,
          content_type: "text",
          session_id: entry.sessionId ?? "",
          metadata: {
            source: "openclaw",
            capture: "auto",
            capture_kind: request.kind,
            turns: plan.turns,
            end_reason: request.endReason,
          },
        },
        timeoutMs: config.requestTimeoutMs,
      });
      // Only a 2xx gets here; on any error the mark stays, so the next turn resends.
      await writeState(path, plan.next);
    } catch (err) {
      if (err instanceof KemoryError && err.kind === "not_signed_in") {
        log.debug("capture skipped: not signed in");
        return;
      }
      log.failure("capture", err);
    }
  }

  function queueCapture(entry: PendingCapture, request: CaptureRequest): Promise<void> {
    const key = pendingKey(entry.agentId, entry.sessionKey);
    const run = (chains.get(key) ?? Promise.resolve()).then(() => capture(entry, request));
    chains.set(key, run);
    void run.then(() => {
      if (chains.get(key) === run) chains.delete(key);
    });
    return run;
  }

  const timeout = { timeoutMs: config.requestTimeoutMs + HOST_TIMEOUT_MARGIN_MS };

  api.on(
    "agent_end",
    async (event, ctx) => {
      try {
        if (!event.success || !memoryAllowed(ctx) || !ctx.sessionKey) return;
        const prompts = extractUserPrompts(event.messages ?? []);
        if (prompts.length === 0) return;
        const entry: PendingCapture = {
          agentId: ctx.agentId ?? "",
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          channel: ctx.channel ?? "unknown",
          prompts,
        };
        pending.set(pendingKey(ctx.agentId, ctx.sessionKey), entry);
        await queueCapture(entry, {
          kind: "incremental",
          when: "mid-session",
          endReason: "agent_end",
        });
      } catch (err) {
        log.failure("capture", err);
      }
    },
    timeout,
  );

  api.on(
    "before_compaction",
    async (_event, ctx) => {
      try {
        if (!memoryAllowed(ctx) || !ctx.sessionKey) return;
        const entry = pending.get(pendingKey(ctx.agentId, ctx.sessionKey));
        if (!entry) return;
        await queueCapture(entry, {
          kind: "flush",
          when: "before compaction",
          endReason: "compaction",
        });
      } catch (err) {
        log.failure("capture", err);
      }
    },
    timeout,
  );

  api.on(
    "session_end",
    async (event, ctx) => {
      try {
        const sessionKey = event.sessionKey ?? ctx.sessionKey;
        if (!sessionKey) return;
        const flushes: Promise<void>[] = [];
        for (const [key, entry] of pending) {
          if (entry.sessionKey !== sessionKey) continue;
          if (ctx.agentId !== undefined && entry.agentId !== ctx.agentId) continue;
          flushes.push(
            queueCapture(entry, {
              kind: "flush",
              when: "at session end",
              endReason: `session_end:${event.reason ?? "unknown"}`,
            }).then(() => {
              // A newer turn may have replaced the entry while the flush ran.
              if (pending.get(key) === entry) pending.delete(key);
            }),
          );
        }
        await Promise.all(flushes);
      } catch (err) {
        log.failure("capture", err);
      }
    },
    timeout,
  );

  api.on(
    "gateway_stop",
    async () => {
      try {
        await Promise.all(
          [...pending.values()].map((entry) =>
            queueCapture(entry, {
              kind: "flush",
              when: "at session end",
              endReason: "gateway_stop",
            }),
          ),
        );
      } catch (err) {
        log.failure("capture", err);
      }
    },
    timeout,
  );
}
