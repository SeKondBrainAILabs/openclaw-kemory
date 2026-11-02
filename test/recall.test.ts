import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthProvider } from "../src/auth.js";
import { createKemoryClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { MEMORY_INSTRUCTION_LINES } from "../src/context.js";
import plugin from "../src/index.js";
import { createLog } from "../src/log.js";
import { registerRecall } from "../src/recall.js";
import type { PluginDeps } from "../src/types.js";
import { VERSION } from "../src/version.js";
import { createFakeApi, type FakeApi } from "./helpers/fake-api.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

const CONTEXT_PATH = "/api/v1/user/context?depth=l3";
const MINUTE = 60_000;

const CONTEXT_BODY = {
  namespaces: [{ namespace: "user:prefs", summary: "Likes terse answers." }],
};
const RENDERED_LINE = "- [user:prefs] Likes terse answers.";

const OWNER = { memoryAudience: { kind: "owner-private" }, sessionKey: "agent:main:main" };

let fake: FakeKemory;
let home: ReturnType<typeof useTempHome>;
let clock: number;

beforeEach(async () => {
  home = useTempHome();
  fake = await startFakeKemory();
  clock = 1_000_000;
});

afterEach(async () => {
  home.restore();
  await fake.close();
});

function setup(raw: Record<string, unknown> = {}) {
  const fakeApi = createFakeApi();
  const config = parseConfig({ baseUrl: fake.url, apiKey: "test-key-123456", ...raw }, {});
  const log = createLog(fakeApi.api.logger, { debug: true });
  const auth = createAuthProvider(config, { log, home: home.home });
  const client = createKemoryClient(auth, { version: VERSION });
  const deps: PluginDeps = { config, client, auth, log, home: home.home };
  registerRecall(fakeApi.api, deps, { now: () => clock });
  return fakeApi;
}

function contextRequests() {
  return fake.requests.filter((r) => r.path === CONTEXT_PATH);
}

function warnings(fakeApi: FakeApi) {
  return fakeApi.logs.filter((l) => l.level === "warn");
}

async function recall(fakeApi: FakeApi, ctx: unknown): Promise<unknown> {
  return await fakeApi.runHook("before_prompt_build", { prompt: "hi", messages: [] }, ctx);
}

describe("recall hook", () => {
  it("an owner-private turn gets appendSystemContext from one GET depth=l3", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup({ contextMaxChars: 1000, contextNamespaces: ["user:prefs"] });

    const result = (await recall(fakeApi, OWNER)) as { appendSystemContext: string };

    expect(result.appendSystemContext).toContain("<kemory-context>");
    expect(result.appendSystemContext).toContain(RENDERED_LINE);
    expect(contextRequests()).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers["x-api-key"]).toBe("test-key-123456");
  });

  it("applies contextMaxChars and contextNamespaces from the config", async () => {
    fake.on("GET", CONTEXT_PATH, {
      body: {
        namespaces: [
          { namespace: "keep", summary: "k".repeat(300) },
          { namespace: "keep", summary: "second" },
          { namespace: "drop", summary: "filtered" },
        ],
      },
    });
    const fakeApi = setup({ contextMaxChars: 500, contextNamespaces: ["keep"] });

    const result = (await recall(fakeApi, OWNER)) as { appendSystemContext: string };

    expect(result.appendSystemContext).not.toContain("[drop]");
    expect(result.appendSystemContext).toContain("- [keep] second");
    expect(result.appendSystemContext).toContain("k".repeat(300));
  });

  it("the same session reuses the context for 10 minutes and refetches after", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup();

    const first = await recall(fakeApi, OWNER);
    clock += 10 * MINUTE - 1;
    const second = await recall(fakeApi, OWNER);
    expect(second).toEqual(first);
    expect(contextRequests()).toHaveLength(1);

    clock += 1;
    await recall(fakeApi, OWNER);
    expect(contextRequests()).toHaveLength(2);
  });

  it("keeps a separate cache entry per agent and session", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup();

    await recall(fakeApi, { ...OWNER, agentId: "a" });
    await recall(fakeApi, { ...OWNER, agentId: "b" });
    await recall(fakeApi, { ...OWNER, agentId: "a", sessionKey: "agent:a:other" });
    expect(contextRequests()).toHaveLength(3);

    await recall(fakeApi, { ...OWNER, agentId: "a" });
    expect(contextRequests()).toHaveLength(3);
  });

  it("conversation audience, missing audience, cron and heartbeat triggers, incognito keys and inter_session provenance get nothing and send no request", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup();
    const cases: Record<string, unknown> = {
      conversation: { ...OWNER, memoryAudience: { kind: "conversation" } },
      "missing audience": { sessionKey: "agent:main:main" },
      "undefined ctx": undefined,
      cron: { ...OWNER, trigger: "cron" },
      heartbeat: { ...OWNER, trigger: "heartbeat" },
      incognito: { ...OWNER, sessionKey: "agent:main:dashboard:incognito-abc" },
      inter_session: { ...OWNER, inputProvenance: { kind: "inter_session" } },
      "no session key": { memoryAudience: { kind: "owner-private" } },
    };

    for (const [name, ctx] of Object.entries(cases)) {
      expect(await recall(fakeApi, ctx), name).toBeUndefined();
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("an excluded turn gets nothing even when the same session has a cached context", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup();
    await recall(fakeApi, OWNER);

    const result = await recall(fakeApi, { ...OWNER, memoryAudience: { kind: "conversation" } });

    expect(result).toBeUndefined();
  });

  it("a Kemory 500 returns the last good text or nothing, warns once, and skips requests for 60 s", async () => {
    fake.on("GET", CONTEXT_PATH, { status: 500, body: { detail: "boom" } });
    const fakeApi = setup();

    expect(await recall(fakeApi, OWNER)).toBeUndefined();
    expect(warnings(fakeApi)).toHaveLength(1);
    expect(warnings(fakeApi)[0]?.msg).toContain("recall failed");

    // The skip window covers every session, not only the one that failed.
    clock += 59_999;
    expect(await recall(fakeApi, OWNER)).toBeUndefined();
    expect(await recall(fakeApi, { ...OWNER, sessionKey: "agent:main:other" })).toBeUndefined();
    expect(contextRequests()).toHaveLength(1);
    expect(warnings(fakeApi)).toHaveLength(1);

    // Kemory recovers once the window is over.
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    clock += 1;
    const result = (await recall(fakeApi, OWNER)) as { appendSystemContext: string };
    expect(result.appendSystemContext).toContain(RENDERED_LINE);
    expect(contextRequests()).toHaveLength(2);
  });

  it("a Kemory 500 after a good fetch returns that text even once it is stale", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup();
    const good = await recall(fakeApi, OWNER);

    fake.on("GET", CONTEXT_PATH, { status: 500 });
    clock += 11 * MINUTE;
    expect(await recall(fakeApi, OWNER)).toEqual(good);
    expect(contextRequests()).toHaveLength(2);

    // The stale entry is pruned like any other, so the skip window has no text to give.
    clock += 30_000;
    expect(await recall(fakeApi, OWNER)).toBeUndefined();
    expect(contextRequests()).toHaveLength(2);
  });

  it("a slow Kemory returns within recallTimeoutMs plus 500 ms", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY, delayMs: 5000 });
    const fakeApi = setup({ recallTimeoutMs: 200 });

    const started = Date.now();
    const result = await recall(fakeApi, OWNER);
    const elapsed = Date.now() - started;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(700);
    expect(warnings(fakeApi)[0]?.msg).toContain("recall failed");
  });

  it("not signed in returns nothing without a warning", async () => {
    const fakeApi = createFakeApi();
    const config = parseConfig({ baseUrl: fake.url }, {});
    const log = createLog(fakeApi.api.logger, { debug: true });
    const auth = createAuthProvider(config, { log, home: home.home });
    const client = createKemoryClient(auth, { version: VERSION });
    registerRecall(fakeApi.api, { config, client, auth, log, home: home.home });

    expect(await recall(fakeApi, OWNER)).toBeUndefined();

    expect(fake.requests).toHaveLength(0);
    expect(warnings(fakeApi)).toHaveLength(0);
    expect(fakeApi.logs.some((l) => l.level === "error")).toBe(false);
  });

  it("a throwing assertMemoryAudienceCurrent returns nothing", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = setup();
    const revoked = {
      ...OWNER,
      assertMemoryAudienceCurrent: () => {
        throw new Error("audience revoked");
      },
    };

    expect(await recall(fakeApi, revoked)).toBeUndefined();
    expect(contextRequests()).toHaveLength(1);

    // A revoked turn must not leave text behind: the next valid turn fetches again.
    const next = (await recall(fakeApi, OWNER)) as { appendSystemContext: string };
    expect(next.appendSystemContext).toContain(RENDERED_LINE);
    expect(contextRequests()).toHaveLength(2);

    // A cached text is also withheld once the audience is revoked.
    expect(await recall(fakeApi, revoked)).toBeUndefined();
    expect(contextRequests()).toHaveLength(2);
  });

  it("an empty context sends no appendSystemContext", async () => {
    fake.on("GET", CONTEXT_PATH, { body: { namespaces: [] } });
    const fakeApi = setup();

    expect(await recall(fakeApi, OWNER)).toBeUndefined();
    // The empty answer is cached too, so an empty vault is not refetched every turn.
    expect(await recall(fakeApi, OWNER)).toBeUndefined();
    expect(contextRequests()).toHaveLength(1);
  });

  it("registers the hook with a host timeout 500 ms above the recall deadline", () => {
    const fakeApi = setup({ recallTimeoutMs: 1500 });

    expect(fakeApi.hooks.get("before_prompt_build")?.opts).toEqual({ timeoutMs: 2000 });
  });
});

describe("memory capability", () => {
  it("autoRecall false registers no hook but still registers the memory capability with providerRuntime", () => {
    const fakeApi = setup({ autoRecall: false });

    expect(fakeApi.hooks.has("before_prompt_build")).toBe(false);
    expect(fakeApi.memoryCapabilities).toHaveLength(1);
    const [capability] = fakeApi.memoryCapabilities as {
      providerRuntime?: { open: unknown };
    }[];
    expect(typeof capability?.providerRuntime?.open).toBe("function");
  });

  it("registers exactly one capability when autoRecall is on", () => {
    const fakeApi = setup();

    expect(fakeApi.memoryCapabilities).toHaveLength(1);
  });

  it("promptBuilder returns the instruction only when kemory_search is available", () => {
    const fakeApi = setup();
    const [capability] = fakeApi.memoryCapabilities as {
      promptBuilder: (params: { availableTools: Set<string> }) => string[];
    }[];

    expect(capability?.promptBuilder({ availableTools: new Set(["kemory_search", "x"]) })).toEqual(
      MEMORY_INSTRUCTION_LINES,
    );
    expect(capability?.promptBuilder({ availableTools: new Set(["kemory_store"]) })).toEqual([]);
    expect(capability?.promptBuilder({ availableTools: new Set() })).toEqual([]);
  });

  it("does not fail when the host has no registerMemoryCapability", () => {
    const fakeApi = createFakeApi();
    const api = fakeApi.api as unknown as { registerMemoryCapability?: unknown };
    api.registerMemoryCapability = undefined;
    const config = parseConfig({ baseUrl: fake.url, apiKey: "k-123456" }, {});
    const log = createLog(fakeApi.api.logger, { debug: true });
    const auth = createAuthProvider(config, { log, home: home.home });
    const client = createKemoryClient(auth, { version: VERSION });

    expect(() =>
      registerRecall(fakeApi.api, { config, client, auth, log, home: home.home }),
    ).not.toThrow();
    expect(fakeApi.hooks.has("before_prompt_build")).toBe(true);
  });
});

describe("plugin entry wiring", () => {
  it("register wires recall to the real client, so an owner turn sends the API key to the configured host", async () => {
    fake.on("GET", CONTEXT_PATH, { body: CONTEXT_BODY });
    const fakeApi = createFakeApi({ baseUrl: fake.url, apiKey: "wired-key-123456" });

    plugin.register(fakeApi.api);
    const result = (await recall(fakeApi, OWNER)) as { appendSystemContext: string };

    expect(result.appendSystemContext).toContain(RENDERED_LINE);
    expect(fake.requests[0]?.headers["x-api-key"]).toBe("wired-key-123456");
    expect(fakeApi.memoryCapabilities).toHaveLength(1);
  });
});
