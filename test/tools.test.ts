import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthProvider, NOT_SIGNED_IN } from "../src/auth.js";
import { createKemoryClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { createLog } from "../src/log.js";
import { registerTools } from "../src/tools.js";
import type { PluginDeps } from "../src/types.js";
import { VERSION } from "../src/version.js";
import { createFakeApi, type FakeApi } from "./helpers/fake-api.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

const NAMES = ["kemory_search", "kemory_store", "kemory_forget", "kemory_profile"];
const SEARCH_PATH = "/api/v1/memories/search";
const MEMORIES_PATH = "/api/v1/memories";
const CONTEXT_PATH = "/api/v1/user/context?depth=l3";
const ID_A = "0b8b1c3e-5d2a-4c7e-9f10-2a3b4c5d6e7f";
const ID_B = "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910";
const UNAVAILABLE = "Kemory memory is not available in this conversation.";

interface TestTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
  ): Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

type Factory = (ctx: unknown) => TestTool[] | null;

const OWNER = { memoryAudience: { kind: "owner-private" }, sessionKey: "agent:main:main" };

let fake: FakeKemory;
let home: ReturnType<typeof useTempHome>;

beforeEach(async () => {
  home = useTempHome();
  fake = await startFakeKemory();
});

afterEach(async () => {
  home.restore();
  await fake.close();
});

function setup(raw: Record<string, unknown> = {}): { fakeApi: FakeApi; factory: Factory } {
  const fakeApi = createFakeApi();
  const config = parseConfig({ baseUrl: fake.url, apiKey: "test-key-123456", ...raw }, {});
  const log = createLog(fakeApi.api.logger, { debug: true });
  const auth = createAuthProvider(config, { log, home: home.home });
  const client = createKemoryClient(auth, { version: VERSION });
  const deps: PluginDeps = { config, client, auth, log, home: home.home };
  registerTools(fakeApi.api, deps);
  return { fakeApi, factory: fakeApi.tools[0]?.tool as Factory };
}

/** The four tools for a context, by name. */
function toolsFor(factory: Factory, ctx: unknown = OWNER): Record<string, TestTool> {
  const tools = factory(ctx);
  if (!tools) throw new Error("factory returned null");
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

async function text(tool: TestTool | undefined, params: unknown): Promise<string> {
  if (!tool) throw new Error("missing tool");
  const result = await tool.execute("call-1", params);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  return result.content[0]?.text ?? "";
}

function warnings(fakeApi: FakeApi) {
  return fakeApi.logs.filter((l) => l.level === "warn");
}

describe("kemory tools", () => {
  it("the factory returns the four tools for an owner-private ctx and null otherwise", () => {
    const { fakeApi, factory } = setup();

    expect(fakeApi.tools).toHaveLength(1);
    expect(fakeApi.tools[0]?.opts).toEqual({ names: NAMES });

    const tools = factory(OWNER);
    expect(tools?.map((t) => t.name)).toEqual(NAMES);
    for (const tool of tools ?? []) {
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toMatchObject({ type: "object" });
    }

    expect(factory({ memoryAudience: { kind: "conversation" }, sessionKey: "k" })).toBeNull();
    expect(factory({ sessionKey: "k" })).toBeNull();
    expect(factory(undefined)).toBeNull();
    expect(
      factory({
        memoryAudience: { kind: "owner-private" },
        sessionKey: "agent:a:dashboard:incognito-1",
      }),
    ).toBeNull();
  });

  it("the tool names match the manifest", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
    expect(manifest.contracts.tools).toEqual(NAMES);
  });

  it("search sends query, limit (default 5, max 20) and namespace, and lists memory_ids", async () => {
    const { factory } = setup();
    fake.on("POST", SEARCH_PATH, {
      body: {
        items: [
          { memory_id: ID_A, namespace: "user:prefs", content: "Likes tabs", created_at: "x" },
          { memory_id: ID_B, namespace: "team:docs", content: "Uses pnpm", created_at: "y" },
        ],
      },
    });
    const search = toolsFor(factory).kemory_search;

    const reply = await search?.execute("call-1", { query: "editor", namespace: "user:prefs" });

    expect(reply?.content[0]?.text).toBe(
      `Found 2 memories:\n\n1. [user:prefs] Likes tabs (memory_id: ${ID_A})\n\n2. [team:docs] Uses pnpm (memory_id: ${ID_B})`,
    );
    expect(reply?.details).toEqual({
      count: 2,
      items: [
        { memory_id: ID_A, namespace: "user:prefs" },
        { memory_id: ID_B, namespace: "team:docs" },
      ],
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.json()).toEqual({
      query: "editor",
      limit: 5,
      namespace: "user:prefs",
      search_mode: "hybrid",
    });

    await text(search, { query: "q", limit: 12 });
    await text(search, { query: "q", limit: 99 });
    await text(search, { query: "q", limit: 0 });
    const bodies = fake.requests.slice(1).map((r) => r.json() as Record<string, unknown>);
    expect(bodies.map((b) => b.limit)).toEqual([12, 20, 1]);
    expect(bodies.every((b) => !("namespace" in b))).toBe(true);
  });

  it("search cuts long content to 1000 code points", async () => {
    const { factory } = setup();
    const long = "😀".repeat(1200);
    fake.on("POST", SEARCH_PATH, {
      body: { items: [{ memory_id: ID_A, namespace: "n", content: long }] },
    });

    const reply = await text(toolsFor(factory).kemory_search, { query: "q" });

    expect(reply).toBe(`Found 1 memories:\n\n1. [n] ${"😀".repeat(1000)}… (memory_id: ${ID_A})`);
  });

  it("search with no results says so and includes the server guidance", async () => {
    const { factory } = setup();
    const search = toolsFor(factory).kemory_search;

    fake.on("POST", SEARCH_PATH, { body: { items: [] } });
    expect(await text(search, { query: "q" })).toBe("No matching memories.");

    fake.on("POST", SEARCH_PATH, {
      body: { items: [], no_results_guidance: "Try a broader query." },
    });
    const reply = await search?.execute("call-1", { query: "q" });
    expect(reply?.content[0]?.text).toBe("No matching memories.\nTry a broader query.");
    expect(reply?.details).toEqual({ count: 0, items: [] });
  });

  it("store reports the namespace and memory_id", async () => {
    const { factory } = setup();
    fake.on("POST", MEMORIES_PATH, {
      status: 201,
      body: {
        memory_id: ID_A,
        namespace: "user:prefs",
        dedup: { deduplicated: false, kind: "none", similarity: 0 },
      },
    });
    const store = toolsFor(factory).kemory_store;

    expect(
      await text(store, { content: "Prefers tabs", namespace: "user:prefs", tags: ["a", "b"] }),
    ).toBe(`Stored in user:prefs (memory_id: ${ID_A}).`);
    expect(fake.requests[0]?.json()).toEqual({
      content: "Prefers tabs",
      content_type: "text",
      namespace: "user:prefs",
      metadata: { source: "openclaw", tags: ["a", "b"] },
    });

    await text(store, { content: "No namespace" });
    expect(fake.requests[1]?.json()).toEqual({
      content: "No namespace",
      content_type: "text",
      metadata: { source: "openclaw" },
    });
  });

  it("store reports a duplicate and stored nothing new", async () => {
    const { factory } = setup();
    const store = toolsFor(factory).kemory_store;

    fake.on("POST", MEMORIES_PATH, {
      body: {
        memory_id: ID_A,
        namespace: "user:prefs",
        dedup: { deduplicated: true, kind: "near_duplicate", similarity: 0.9712 },
      },
    });
    expect(await text(store, { content: "x" })).toBe(
      `Already known (near_duplicate, similarity 0.97); kept the existing memory ${ID_A} in user:prefs, nothing new was stored.`,
    );

    fake.on("POST", MEMORIES_PATH, {
      body: {
        memory_id: ID_A,
        namespace: "user:prefs",
        dedup: { deduplicated: true, kind: "exact" },
      },
    });
    expect(await text(store, { content: "x" })).toBe(
      `Already known (exact); kept the existing memory ${ID_A} in user:prefs, nothing new was stored.`,
    );
  });

  it("store explains a 409 namespace conflict with the suggestions", async () => {
    const { fakeApi, factory } = setup();
    fake.on("POST", MEMORIES_PATH, {
      status: 409,
      body: {
        detail: {
          requested: "user:pref",
          suggested: [
            { namespace: "user:prefs", similarity: 0.95 },
            { namespace: "user:preferences", similarity: 0.9 },
          ],
        },
      },
    });

    const reply = await text(toolsFor(factory).kemory_store, {
      content: "x",
      namespace: "user:pref",
    });

    expect(reply).toBe(
      "Namespace user:pref is close to existing namespaces: user:prefs, user:preferences. Store again with one of those, or a clearly different name.",
    );
    expect(warnings(fakeApi)).toEqual([]);
  });

  it("forget deletes by id and reports a 404 as not found", async () => {
    const { factory } = setup();
    const forget = toolsFor(factory).kemory_forget;
    fake.on("DELETE", `${MEMORIES_PATH}/${ID_A}`, { status: 204 });
    fake.on("DELETE", `${MEMORIES_PATH}/${ID_B}`, { status: 200, body: { deleted: true } });

    expect(await text(forget, { memoryId: ID_A })).toBe(`Deleted memory ${ID_A}.`);
    expect(await text(forget, { memoryId: ID_B })).toBe(`Deleted memory ${ID_B}.`);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `DELETE ${MEMORIES_PATH}/${ID_A}`,
      `DELETE ${MEMORIES_PATH}/${ID_B}`,
    ]);

    const missing = "11111111-2222-4333-8444-555555555555";
    expect(await text(forget, { memoryId: missing.toUpperCase() })).toBe(
      `No memory with id ${missing.toUpperCase()}.`,
    );
  });

  it("forget rejects an id that is not a UUID without a request", async () => {
    const { fakeApi, factory } = setup();
    const forget = toolsFor(factory).kemory_forget;

    for (const memoryId of ["not-an-id", "../memories", `${ID_A}/extra`, "", "user prefs"]) {
      expect(await text(forget, { memoryId })).toBe(
        "memoryId must be the memory_id that kemory_search returned.",
      );
    }
    expect(await text(forget, {})).toBe(
      "memoryId must be the memory_id that kemory_search returned.",
    );
    expect(fake.requests).toHaveLength(0);
    expect(warnings(fakeApi)).toEqual([]);
  });

  it("forget says it deletes one memory by id and never by query", () => {
    const { factory } = setup();
    const description = toolsFor(factory).kemory_forget?.description ?? "";
    expect(description).toMatch(/exactly one memory by id/i);
    expect(description).toMatch(/never deletes by query/i);
  });

  it("profile lists namespace summaries, filtered by namespace when given", async () => {
    const { factory } = setup();
    fake.on("GET", CONTEXT_PATH, {
      body: {
        namespaces: [
          { namespace: "user:prefs", summary: "  Likes terse answers.  " },
          { namespace: "team:docs", summary: "Docs live in /docs." },
          { namespace: "empty", summary: "   " },
        ],
      },
    });
    const profile = toolsFor(factory).kemory_profile;

    expect(await text(profile, {})).toBe(
      "- [user:prefs] Likes terse answers.\n- [team:docs] Docs live in /docs.",
    );
    expect(await text(profile, { namespace: "team:docs" })).toBe(
      "- [team:docs] Docs live in /docs.",
    );
    expect(await text(profile, { namespace: "nope" })).toBe("No Kemory context yet.");

    fake.on("GET", CONTEXT_PATH, { body: { namespaces: [] } });
    expect(await text(profile, {})).toBe("No Kemory context yet.");
    fake.on("GET", CONTEXT_PATH, { body: "broken" });
    expect(await text(profile, {})).toBe("No Kemory context yet.");
  });

  it("profile cuts the listing to 8000 code points in total", async () => {
    const { factory } = setup();
    fake.on("GET", CONTEXT_PATH, {
      body: {
        namespaces: [
          { namespace: "a", summary: "😀".repeat(5000) },
          { namespace: "b", summary: "😀".repeat(5000) },
        ],
      },
    });

    const reply = await text(toolsFor(factory).kemory_profile, {});

    expect(Array.from(reply)).toHaveLength(8000);
    expect(reply.startsWith(`- [a] ${"😀".repeat(5000)}\n- [b] `)).toBe(true);
  });

  it("not signed in returns NOT_SIGNED_IN as the tool text", async () => {
    const { fakeApi, factory } = setup({ apiKey: undefined });
    const tools = toolsFor(factory);
    const params: Record<string, unknown> = {
      kemory_search: { query: "q" },
      kemory_store: { content: "c" },
      kemory_forget: { memoryId: ID_A },
      kemory_profile: {},
    };

    for (const name of NAMES) {
      expect(await text(tools[name], params[name])).toBe(NOT_SIGNED_IN);
    }
    expect(fake.requests).toHaveLength(0);
    expect(warnings(fakeApi)).toEqual([]);
  });

  it("a Kemory error or timeout returns a failure text and never throws", async () => {
    const { fakeApi, factory } = setup({ requestTimeoutMs: 1000 });
    const tools = toolsFor(factory);

    fake.on("POST", SEARCH_PATH, { status: 500, body: { detail: "boom" } });
    expect(await text(tools.kemory_search, { query: "q" })).toBe(
      "Kemory request failed (http 500); memory is unavailable right now.",
    );

    fake.on("POST", MEMORIES_PATH, { status: 200, rawBody: "not json" });
    expect(await text(tools.kemory_store, { content: "c" })).toBe(
      "Kemory request failed (bad_response 200); memory is unavailable right now.",
    );

    fake.on("DELETE", `${MEMORIES_PATH}/${ID_A}`, {
      status: 403,
      body: { detail: "read-only key" },
    });
    expect(await text(tools.kemory_forget, { memoryId: ID_A })).toBe(
      "Kemory request failed (http 403); memory is unavailable right now.",
    );

    fake.on("GET", CONTEXT_PATH, { delayMs: 1600, body: { namespaces: [] } });
    const started = Date.now();
    expect(await text(tools.kemory_profile, {})).toBe(
      "Kemory request failed (timeout); memory is unavailable right now.",
    );
    expect(Date.now() - started).toBeLessThan(1500);

    const failures = warnings(fakeApi).map((l) => l.msg);
    expect(failures.some((m) => m.startsWith("kemory: tool failed:"))).toBe(true);
  });

  it("every tool gives up at requestTimeoutMs", async () => {
    const { factory } = setup({ requestTimeoutMs: 1000 });
    const tools = toolsFor(factory);
    const slow = { delayMs: 1600, body: {} };
    fake.on("POST", SEARCH_PATH, slow);
    fake.on("POST", MEMORIES_PATH, slow);
    fake.on("DELETE", `${MEMORIES_PATH}/${ID_A}`, slow);
    fake.on("GET", CONTEXT_PATH, slow);

    const started = Date.now();
    const replies = await Promise.all([
      text(tools.kemory_search, { query: "q" }),
      text(tools.kemory_store, { content: "c" }),
      text(tools.kemory_forget, { memoryId: ID_A }),
      text(tools.kemory_profile, {}),
    ]);

    expect(replies).toEqual(
      Array(4).fill("Kemory request failed (timeout); memory is unavailable right now."),
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a malformed store reply is a failure, not a success", async () => {
    const { factory } = setup();
    fake.on("POST", MEMORIES_PATH, { body: { unexpected: true } });

    expect(await text(toolsFor(factory).kemory_store, { content: "c" })).toBe(
      "Kemory request failed (bad_response 200); memory is unavailable right now.",
    );
  });

  it("missing required params are reported without a request", async () => {
    const { factory } = setup();
    const tools = toolsFor(factory);

    expect(await text(tools.kemory_search, {})).toMatch(/query/);
    expect(await text(tools.kemory_store, { content: "" })).toMatch(/content/);
    expect(fake.requests).toHaveLength(0);
  });

  it("a throwing assertMemoryAudienceCurrent returns no memory content", async () => {
    const { factory } = setup();
    const revoked = {
      ...OWNER,
      assertMemoryAudienceCurrent: () => {
        throw new Error("audience changed");
      },
    };
    const tools = toolsFor(factory, revoked);
    fake.on("POST", SEARCH_PATH, {
      body: { items: [{ memory_id: ID_A, namespace: "user:secret", content: "TOP SECRET" }] },
    });
    fake.on("POST", MEMORIES_PATH, {
      status: 409,
      body: { detail: { requested: "user:x", suggested: [{ namespace: "user:secret" }] } },
    });
    fake.on("DELETE", `${MEMORIES_PATH}/${ID_A}`, { status: 404 });
    fake.on("GET", CONTEXT_PATH, {
      body: { namespaces: [{ namespace: "user:secret", summary: "TOP SECRET" }] },
    });

    const replies = [
      await text(tools.kemory_search, { query: "q" }),
      await text(tools.kemory_store, { content: "c", namespace: "user:x" }),
      await text(tools.kemory_forget, { memoryId: ID_A }),
      await text(tools.kemory_profile, {}),
    ];

    expect(replies).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    expect(fake.requests).toHaveLength(4);
  });

  it("calls assertMemoryAudienceCurrent after the request resolves", async () => {
    const { factory } = setup();
    let seenRequests = -1;
    const ctx = {
      ...OWNER,
      assertMemoryAudienceCurrent: () => {
        seenRequests = fake.requests.length;
      },
    };
    fake.on("POST", SEARCH_PATH, { body: { items: [] } });

    await text(toolsFor(factory, ctx).kemory_search, { query: "q" });

    expect(seenRequests).toBe(1);
  });
});
