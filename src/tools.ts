import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { memoryAllowed } from "./audience.js";
import { NOT_SIGNED_IN } from "./auth.js";
import { KemoryError } from "./client.js";
import type { PluginDeps } from "./types.js";

const TOOL_NAMES = ["kemory_search", "kemory_store", "kemory_forget", "kemory_profile"];
const CONTEXT_PATH = "/api/v1/user/context?depth=l3";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const EXCERPT_CODE_POINTS = 1000;
const PROFILE_CODE_POINTS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNAVAILABLE = "Kemory memory is not available in this conversation.";
const BAD_MEMORY_ID = "memoryId must be the memory_id that kemory_search returned.";

interface ToolContext {
  assertMemoryAudienceCurrent?: () => void;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

function result(text: string, details: unknown = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function cut(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function limitFrom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * Runs one tool call: the request, then the audience recheck, then the
 * rendering. The recheck sits between the two so that a conversation whose
 * audience changed while we waited gets no memory content, whether the reply
 * was a success or an error that carries memory text (a 409's suggestions).
 * It never throws: a failure becomes the tool's text and a log line.
 */
async function run<T>(
  deps: PluginDeps,
  ctx: ToolContext,
  request: () => Promise<T>,
  render: (res: T) => ToolResult,
  expected: (err: KemoryError) => ToolResult | undefined = () => undefined,
): Promise<ToolResult> {
  let outcome: { res: T } | { err: unknown };
  try {
    outcome = { res: await request() };
  } catch (err) {
    outcome = { err };
  }

  try {
    ctx.assertMemoryAudienceCurrent?.();
  } catch {
    return result(UNAVAILABLE, { error: "audience" });
  }

  try {
    if (!("err" in outcome)) return render(outcome.res);
    const err = outcome.err;
    if (err instanceof KemoryError) {
      if (err.kind === "not_signed_in") {
        deps.log.debug("tool: not signed in");
        return result(NOT_SIGNED_IN, { error: "not_signed_in" });
      }
      const handled = expected(err);
      if (handled) return handled;
    }
    throw err;
  } catch (err) {
    deps.log.failure("tool", err);
    const kemory = err instanceof KemoryError ? err : undefined;
    const kind = kemory?.kind ?? "error";
    const status = kemory?.status;
    return result(
      `Kemory request failed (${kind}${status === undefined ? "" : ` ${status}`}); memory is unavailable right now.`,
      { error: kind, status },
    );
  }
}

function buildTools(deps: PluginDeps, ctx: ToolContext): AnyAgentTool[] {
  const { client, config } = deps;
  const timeoutMs = config.requestTimeoutMs;

  const search: AnyAgentTool = {
    name: "kemory_search",
    label: "Kemory search",
    description:
      "Search the user's Kemory memory for saved facts, decisions and past sessions. Returns matching memories with their memory_id.",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "What to look for, in the words it was saved with.",
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: "Most results to return (default 5).",
        }),
      ),
      namespace: Type.Optional(Type.String({ description: "Only search this namespace." })),
    }),
    async execute(_toolCallId, params) {
      const { query, limit, namespace } = asRecord(params);
      if (!nonEmpty(query)) return result("query must be a non-empty string.");
      const body: Record<string, unknown> = {
        query,
        limit: limitFrom(limit),
        search_mode: "hybrid",
      };
      const ns = nonEmpty(namespace);
      if (ns) body.namespace = ns;

      return await run(
        deps,
        ctx,
        () => client.request("POST", "/api/v1/memories/search", { body, timeoutMs }),
        (res) => {
          const reply = asRecord(res.body);
          const list = Array.isArray(reply.items) ? reply.items : [];
          const items = list.flatMap((entry) => {
            const { memory_id: id, namespace: itemNs, content } = asRecord(entry);
            if (typeof id !== "string") return [];
            return [
              {
                id,
                namespace: typeof itemNs === "string" ? itemNs : "unknown",
                content: typeof content === "string" ? content : "",
              },
            ];
          });
          const details = {
            count: items.length,
            items: items.map((i) => ({ memory_id: i.id, namespace: i.namespace })),
          };
          if (items.length === 0) {
            const guidance = nonEmpty(reply.no_results_guidance);
            return result(
              guidance ? `No matching memories.\n${guidance}` : "No matching memories.",
              details,
            );
          }
          const entries = items.map((i, n) => {
            const long = Array.from(i.content).length > EXCERPT_CODE_POINTS;
            const content = long ? `${cut(i.content, EXCERPT_CODE_POINTS)}…` : i.content;
            return `${n + 1}. [${i.namespace}] ${content} (memory_id: ${i.id})`;
          });
          return result(`Found ${items.length} memories:\n\n${entries.join("\n\n")}`, details);
        },
      );
    },
  };

  const store: AnyAgentTool = {
    name: "kemory_store",
    label: "Kemory store",
    description:
      "Save one fact, preference or decision to the user's Kemory memory. The text is stored as written, so leave secrets out. Reports when Kemory already had it.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, description: "What to remember, in searchable words." }),
      namespace: Type.Optional(
        Type.String({ description: "Where to save it; omit to let Kemory choose." }),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional labels." })),
    }),
    async execute(_toolCallId, params) {
      const { content, namespace, tags } = asRecord(params);
      if (!nonEmpty(content)) return result("content must be a non-empty string.");
      const metadata: Record<string, unknown> = { source: "openclaw" };
      if (Array.isArray(tags) && tags.length > 0) {
        metadata.tags = tags.filter((t): t is string => typeof t === "string");
      }
      const body: Record<string, unknown> = { content, content_type: "text", metadata };
      const ns = nonEmpty(namespace);
      if (ns) body.namespace = ns;

      return await run(
        deps,
        ctx,
        () => client.request("POST", "/api/v1/memories", { body, timeoutMs }),
        (res) => {
          const reply = asRecord(res.body);
          const { memory_id: id, namespace: savedIn } = reply;
          if (typeof id !== "string" || typeof savedIn !== "string") {
            throw new KemoryError("bad_response", "POST", "/api/v1/memories", {
              status: res.status,
            });
          }
          const dedup = asRecord(reply.dedup);
          if (dedup.deduplicated === true) {
            const kind = typeof dedup.kind === "string" ? dedup.kind : "duplicate";
            const similarity =
              typeof dedup.similarity === "number"
                ? `, similarity ${dedup.similarity.toFixed(2)}`
                : "";
            return result(
              `Already known (${kind}${similarity}); kept the existing memory ${id} in ${savedIn}, nothing new was stored.`,
              { memory_id: id, namespace: savedIn, deduplicated: true },
            );
          }
          return result(`Stored in ${savedIn} (memory_id: ${id}).`, {
            memory_id: id,
            namespace: savedIn,
            deduplicated: false,
          });
        },
        (err) => {
          if (err.kind !== "http" || err.status !== 409) return undefined;
          const detail = asRecord(asRecord(err.body).detail);
          const suggested = Array.isArray(detail.suggested) ? detail.suggested : [];
          const names = suggested
            .map((s) => asRecord(s).namespace)
            .filter((n): n is string => typeof n === "string");
          if (typeof detail.requested !== "string" || names.length === 0) return undefined;
          return result(
            `Namespace ${detail.requested} is close to existing namespaces: ${names.join(", ")}. Store again with one of those, or a clearly different name.`,
            { error: "namespace_conflict", requested: detail.requested, suggested: names },
          );
        },
      );
    },
  };

  const forget: AnyAgentTool = {
    name: "kemory_forget",
    label: "Kemory forget",
    description:
      "Delete exactly one memory by id, using the memory_id that kemory_search returned. This tool never deletes by query: search first, then pass the id of the memory to remove.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "The memory_id that kemory_search returned." }),
    }),
    async execute(_toolCallId, params) {
      const { memoryId } = asRecord(params);
      if (typeof memoryId !== "string" || !UUID.test(memoryId)) return result(BAD_MEMORY_ID);

      return await run(
        deps,
        ctx,
        () =>
          client.request("DELETE", `/api/v1/memories/${encodeURIComponent(memoryId)}`, {
            timeoutMs,
          }),
        () => result(`Deleted memory ${memoryId}.`, { memory_id: memoryId, deleted: true }),
        (err) =>
          err.kind === "http" && err.status === 404
            ? result(`No memory with id ${memoryId}.`, { memory_id: memoryId, deleted: false })
            : undefined,
      );
    },
  };

  const profile: AnyAgentTool = {
    name: "kemory_profile",
    label: "Kemory profile",
    description:
      "Show the user's Kemory profile: a summary of what is saved in each namespace. Use it to see what Kemory knows and which namespaces exist.",
    parameters: Type.Object({
      namespace: Type.Optional(Type.String({ description: "Only show this namespace." })),
    }),
    async execute(_toolCallId, params) {
      const wanted = nonEmpty(asRecord(params).namespace);

      return await run(
        deps,
        ctx,
        () => client.request("GET", CONTEXT_PATH, { timeoutMs }),
        (res) => {
          const list = asRecord(res.body).namespaces;
          const lines = (Array.isArray(list) ? list : []).flatMap((entry) => {
            const { namespace, summary } = asRecord(entry);
            if (typeof namespace !== "string" || typeof summary !== "string") return [];
            if (summary.trim() === "" || (wanted !== undefined && namespace !== wanted)) return [];
            return [`- [${namespace}] ${summary.trim()}`];
          });
          if (lines.length === 0) return result("No Kemory context yet.", { count: 0 });
          return result(cut(lines.join("\n"), PROFILE_CODE_POINTS), { count: lines.length });
        },
      );
    },
  };

  return [search, store, forget, profile];
}

/**
 * Registers the four memory tools through a factory, so each turn decides
 * whether to offer them: only an owner's direct turn gets any.
 */
export function registerTools(api: OpenClawPluginApi, deps: PluginDeps): void {
  api.registerTool((ctx) => (memoryAllowed(ctx) ? buildTools(deps, ctx) : null), {
    names: TOOL_NAMES,
  });
}
