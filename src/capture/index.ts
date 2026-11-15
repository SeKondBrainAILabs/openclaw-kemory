import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { memoryAllowed } from "../audience.js";
import { KemoryError } from "../client.js";
import type { PluginDeps } from "../types.js";
import { type CaptureWhen, planCapture } from "./plan.js";
import { extractUserPrompts } from "./prompts.js";
import { readState, removeState, statePath, writeState } from "./state.js";

const MEMORIES_PATH = "/api/v1/memories";
// The host's hook timeout does not cancel a handler, so the client deadline is
// what bounds each capture; the host timeout only has to sit just above it.
const HOST_TIMEOUT_MARGIN_MS = 2000;

// OpenClaw keeps the session key across these, so a stale mark would be matched against
// the next session's prompts. /new, /reset and a delete start from nothing.
const REMOVE_MARK_REASONS = new Set(["new", "reset", "deleted"]);
// Idle and daily rotation replay the old tail into the new window: the mark is rewound
// instead, so the replayed tail is found by fingerprint and not sent twice.
const REWIND_MARK_REASONS = new Set(["idle", "daily"]);

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
 * The pending entries of one session. Hooks whose host context carries no audience (and
 * sometimes no agentId) find their entries this way: by session key, narrowed to one agent
 * only when the context names it.
 */
function entriesOfSession(
  pending: Map<string, PendingCapture>,
  sessionKey: string,
  agentId: string | undefined,
): [string, PendingCapture][] {
  return [...pending].filter(
    ([, entry]) =>
      entry.sessionKey === sessionKey && (agentId === undefined || entry.agentId === agentId),
  );
}

/**
 * Saves the owner's prompts to Kemory after each successful turn, and flushes whatever is
 * still unsent when a session compacts or ends and when the gateway stops. Nothing is
 * buffered unless a turn passed memoryAllowed, and extractUserPrompts keeps only the
 * messages OpenClaw marks as the owner's. The flush hooks are matched to a session by its
 * key, without an audience check: OpenClaw's compaction and session-end contexts carry no
 * audience, and they can only send prompts that were already cleared.
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

  /** Removes or rewinds one session's mark, after anything already queued for it. */
  function queueMarkChange(
    agentId: string,
    sessionKey: string,
    action: "remove" | "rewind",
  ): Promise<void> {
    const key = pendingKey(agentId, sessionKey);
    const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const path = statePath(deps.home, agentId, sessionKey);
        if (action === "remove") {
          await removeState(path);
          return;
        }
        const state = await readState(path);
        if (state) await writeState(path, { ...state, captured_turns: 0 });
      } catch (err) {
        log.failure("capture", err);
      }
    });
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
        // No audience check: OpenClaw sends this hook a context without one on its main
        // compaction paths. Only prompts from a gated agent_end are ever pending. The entry
        // stays, because the session goes on after compacting.
        if (!ctx.sessionKey) return;
        await Promise.all(
          entriesOfSession(pending, ctx.sessionKey, ctx.agentId).map(([, entry]) =>
            queueCapture(entry, {
              kind: "flush",
              when: "before compaction",
              endReason: "compaction",
            }),
          ),
        );
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
        const reason = event.reason ?? "unknown";
        const entries = entriesOfSession(pending, sessionKey, ctx.agentId);
        const action = REMOVE_MARK_REASONS.has(reason)
          ? "remove"
          : REWIND_MARK_REASONS.has(reason)
            ? "rewind"
            : undefined;
        const work: Promise<void>[] = [];
        if (reason === "deleted") {
          // Nothing more is sent for a deleted session, so gateway_stop must not find it.
          for (const [key] of entries) pending.delete(key);
        } else {
          for (const [key, entry] of entries) {
            work.push(
              queueCapture(entry, {
                kind: "flush",
                when: "at session end",
                endReason: `session_end:${reason}`,
              }).then(() => {
                // A newer turn may have replaced the entry while the flush ran.
                if (pending.get(key) === entry) pending.delete(key);
              }),
            );
          }
        }
        if (action) {
          // After a restart nothing is pending but the mark file persists, and agent_end
          // writes it under ctx.agentId ?? ''.
          const agentIds = new Set([
            ...entries.map(([, entry]) => entry.agentId),
            ctx.agentId ?? "",
          ]);
          // Queued after the flushes above, so each runs behind its own session's flush.
          for (const agentId of agentIds) work.push(queueMarkChange(agentId, sessionKey, action));
        }
        await Promise.all(work);
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
