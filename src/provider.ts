import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { NOT_SIGNED_IN } from "./auth.js";
import { KemoryError } from "./client.js";
import type { PluginDeps } from "./types.js";

export type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type OpenParams = Parameters<MemoryProviderRuntime["open"]>[0];
type MemoryProviderHandle = NonNullable<
  Awaited<ReturnType<MemoryProviderRuntime["open"]>>["provider"]
>;
type CallerContext = OpenParams["context"];

const PROVIDER_ID = "kemory";
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;
const EXCERPT_CODE_POINTS = 1000;
const DENIED = "kemory: memory is only available in the owner's direct sessions";

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Search and get expose the owner's private memory, so they run only for the
 * agent's own direct sessions. Operator and host authority never qualify, and
 * a missing audience is no audience: the host decides who the owner is.
 */
function assertOwnerSession(context: CallerContext, agentId: string): void {
  const { authority } = context;
  if (
    authority.kind !== "session" ||
    authority.audience?.kind !== "owner-private" ||
    authority.audience.agentId !== agentId
  ) {
    throw new Error(DENIED);
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof KemoryError && err.kind === "http" && err.status === 404;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function createHandle(
  deps: PluginDeps,
  agentId: string,
  context: CallerContext,
): MemoryProviderHandle {
  const { config, client, auth } = deps;

  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },

    async search(request) {
      assertOwnerSession(context, agentId);
      const body: Record<string, unknown> = {
        query: request.query,
        limit: clamp(request.maxResults, 1, MAX_RESULTS, DEFAULT_RESULTS),
        search_mode: "hybrid",
      };
      // The server enforces the floor: its replies carry no score to filter on here.
      if (request.minScore !== undefined) body.min_score = request.minScore;

      context.assertCurrent();
      const res = await client.request("POST", "/api/v1/memories/search", {
        body,
        timeoutMs: config.requestTimeoutMs,
      });
      context.assertCurrent();

      const items = asRecord(res.body).items;
      const hits = (Array.isArray(items) ? items : []).flatMap((item) => {
        const { memory_id: id, content } = asRecord(item);
        if (typeof id !== "string") return [];
        const text = typeof content === "string" ? content : "";
        return [
          {
            reference: { providerId: PROVIDER_ID, id },
            excerpt: Array.from(text).slice(0, EXCERPT_CODE_POINTS).join(""),
            source: "memory",
          },
        ];
      });
      return { hits };
    },

    async get(request) {
      assertOwnerSession(context, agentId);
      const { reference } = request;
      if (reference.providerId !== PROVIDER_ID) {
        throw new Error(`kemory: cannot read a reference from provider "${reference.providerId}"`);
      }
      const path = `/api/v1/memories/${encodeURIComponent(reference.id)}`;

      context.assertCurrent();
      let content: unknown;
      let found = true;
      try {
        const res = await client.request("GET", path, { timeoutMs: config.requestTimeoutMs });
        content = asRecord(res.body).content;
      } catch (err) {
        if (!isNotFound(err)) throw err;
        found = false;
      }
      context.assertCurrent();

      if (!found) return { status: "not_found" };
      if (typeof content !== "string") throw new KemoryError("bad_response", "GET", path);
      return { status: "ok", reference, text: content };
    },

    // Answerable for every caller, including operator and host status checks:
    // it reads only the local credential and sends nothing to Kemory.
    async health() {
      try {
        const resolved = await auth.resolve(AbortSignal.timeout(config.requestTimeoutMs));
        if (!resolved) return { status: "unavailable", message: NOT_SIGNED_IN };
        return { status: "ready", message: `signed in (${resolved.source})` };
      } catch (err) {
        deps.log.failure("health", err);
        return { status: "degraded", message: "sign-in check failed" };
      }
    },

    async close() {},
  };
}

/**
 * OpenClaw mints `memoryAudience` for a turn only when the memory slot's owner
 * registered a provider runtime, so without this no hook or tool would ever be
 * told whose turn it is. The provider is read-only: writes go through the tools.
 */
export function createProviderRuntime(deps: PluginDeps): MemoryProviderRuntime {
  return {
    async open({ agentId, context }) {
      return { provider: createHandle(deps, agentId, context) };
    },
  };
}
