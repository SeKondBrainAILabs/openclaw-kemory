import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthProvider, createAuthProvider, NOT_SIGNED_IN } from "../src/auth.js";
import { createKemoryClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { createLog } from "../src/log.js";
import { createProviderRuntime } from "../src/provider.js";
import type { PluginDeps } from "../src/types.js";
import { VERSION } from "../src/version.js";
import { createFakeApi } from "./helpers/fake-api.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type OpenParams = Parameters<MemoryProviderRuntime["open"]>[0];

const DENIED = "kemory: memory is only available in the owner's direct sessions";
const MEMORY_ID = "11111111-2222-3333-4444-555555555555";

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

function makeDeps(raw: Record<string, unknown> = {}, auth?: AuthProvider): PluginDeps {
  const logger = createFakeApi().api.logger;
  const config = parseConfig({ baseUrl: fake.url, apiKey: "test-key-123456", ...raw }, {});
  const log = createLog(logger, { debug: true });
  const realAuth = auth ?? createAuthProvider(config, { log, home: home.home });
  const client = createKemoryClient(realAuth, { version: VERSION });
  return { config, client, auth: realAuth, log, home: home.home };
}

type Authority = {
  kind: string;
  [key: string]: unknown;
};

function contextFor(authority: Authority, assertCurrent: () => void = () => {}) {
  return { authority, assertCurrent } as unknown as OpenParams["context"];
}

function ownerAuthority(agentId = "main"): Authority {
  return {
    kind: "session",
    sessionKey: `agent:${agentId}:main`,
    sandboxed: false,
    audience: { kind: "owner-private", agentId },
  };
}

async function open(deps: PluginDeps, authority: Authority, assertCurrent?: () => void) {
  const result = await createProviderRuntime(deps).open({
    cfg: {},
    agentId: "main",
    context: contextFor(authority, assertCurrent),
  } as unknown as OpenParams);
  if (!result.provider) throw new Error("expected a provider");
  return result.provider;
}

const DENIED_CALLERS: Record<string, Authority> = {
  operator: { kind: "operator", scopes: ["operator.admin"] },
  host: { kind: "host", operation: "status" },
  "conversation audience": {
    kind: "session",
    sessionKey: "agent:main:group",
    sandboxed: false,
    audience: {
      kind: "conversation",
      agentId: "main",
      sessionKey: "agent:main:group",
      sessionId: "s",
    },
  },
  "missing audience": { kind: "session", sessionKey: "agent:main:main", sandboxed: false },
  "other agent": ownerAuthority("other"),
};

describe("provider runtime", () => {
  it("opens a provider with the declared capabilities and no candidates or refresh method", async () => {
    const provider = await open(makeDeps(), ownerAuthority());

    expect(provider.capabilities).toEqual({
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
    });
    expect(typeof provider.search).toBe("function");
    expect(typeof provider.get).toBe("function");
    expect(typeof provider.health).toBe("function");
    await expect(provider.close()).resolves.toBeUndefined();
    expect("candidates" in provider).toBe(false);
    expect("refresh" in provider).toBe(false);
  });

  it("opens for every caller, because access is decided per call", async () => {
    for (const authority of Object.values(DENIED_CALLERS)) {
      const result = await createProviderRuntime(makeDeps()).open({
        cfg: {},
        agentId: "main",
        context: contextFor(authority),
      } as unknown as OpenParams);
      expect(result.provider).not.toBeNull();
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("search for an owner-private session sends the query, limit and min_score and maps items to hits", async () => {
    fake.on("POST", "/api/v1/memories/search", {
      body: {
        items: [
          { memory_id: "m1", namespace: "user:prefs", content: "Likes terse answers." },
          { memory_id: "m2", namespace: "proj:a", content: "😀".repeat(1200) },
        ],
      },
    });
    const provider = await open(makeDeps({ requestTimeoutMs: 5000 }), ownerAuthority());

    const page = await provider.search({ query: "terse", maxResults: 7, minScore: 0.4 });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.json()).toEqual({
      query: "terse",
      limit: 7,
      search_mode: "hybrid",
      min_score: 0.4,
    });
    expect(page.hits).toHaveLength(2);
    expect(page.hits[0]).toEqual({
      reference: { providerId: "kemory", id: "m1" },
      excerpt: "Likes terse answers.",
      source: "memory",
    });
    expect(Array.from(page.hits[1]?.excerpt ?? "")).toHaveLength(1000);
    expect(page.hits[1]?.reference).toEqual({ providerId: "kemory", id: "m2" });
    expect("score" in (page.hits[0] ?? {})).toBe(false);
  });

  it("search defaults to 5 results, clamps to 1-20 and leaves min_score out when unset", async () => {
    fake.on("POST", "/api/v1/memories/search", { body: { items: [] } });
    const provider = await open(makeDeps(), ownerAuthority());

    await provider.search({ query: "a" });
    await provider.search({ query: "b", maxResults: 500 });
    await provider.search({ query: "c", maxResults: 0 });

    const bodies = fake.requests.map((r) => r.json());
    expect(bodies).toEqual([
      { query: "a", limit: 5, search_mode: "hybrid" },
      { query: "b", limit: 20, search_mode: "hybrid" },
      { query: "c", limit: 1, search_mode: "hybrid" },
    ]);
  });

  it("search rejects on a Kemory error instead of returning no hits", async () => {
    fake.on("POST", "/api/v1/memories/search", { status: 500, body: { detail: "boom" } });
    const provider = await open(makeDeps(), ownerAuthority());

    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      kind: "http",
      status: 500,
    });
  });

  it("search and get reject operator, host, conversation, missing-audience and other-agent callers without a request", async () => {
    for (const [name, authority] of Object.entries(DENIED_CALLERS)) {
      const provider = await open(makeDeps(), authority);

      await expect(provider.search({ query: "x" }), `search ${name}`).rejects.toThrow(DENIED);
      await expect(
        provider.get({ reference: { providerId: "kemory", id: MEMORY_ID } }),
        `get ${name}`,
      ).rejects.toThrow(DENIED);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("get returns ok with the content, not_found on 404, and rejects on other errors", async () => {
    fake.on("GET", `/api/v1/memories/${MEMORY_ID}`, {
      body: { memory_id: MEMORY_ID, content: "the full text" },
    });
    fake.on("GET", "/api/v1/memories/gone", { status: 404, body: { detail: "not found" } });
    fake.on("GET", "/api/v1/memories/broken", { status: 500, body: {} });
    const provider = await open(makeDeps(), ownerAuthority());

    const reference = { providerId: "kemory", id: MEMORY_ID };
    await expect(provider.get({ reference })).resolves.toEqual({
      status: "ok",
      reference,
      text: "the full text",
    });
    await expect(
      provider.get({ reference: { providerId: "kemory", id: "gone" } }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      provider.get({ reference: { providerId: "kemory", id: "broken" } }),
    ).rejects.toMatchObject({ kind: "http", status: 500 });
  });

  it("get rejects a reference from another provider without a request, and encodes the id", async () => {
    fake.on("GET", "/api/v1/memories/a%2Fb%20c", { body: { memory_id: "x", content: "t" } });
    const provider = await open(makeDeps(), ownerAuthority());

    await expect(
      provider.get({ reference: { providerId: "builtin", id: MEMORY_ID } }),
    ).rejects.toThrow(/kemory/);
    expect(fake.requests).toHaveLength(0);

    await provider.get({ reference: { providerId: "kemory", id: "a/b c" } });
    expect(fake.requests[0]?.path).toBe("/api/v1/memories/a%2Fb%20c");
  });

  it("health is ready when signed in and unavailable with NOT_SIGNED_IN otherwise, for any authority, with no request", async () => {
    for (const authority of [ownerAuthority(), ...Object.values(DENIED_CALLERS)]) {
      const ready = await (await open(makeDeps(), authority)).health();
      expect(ready).toEqual({ status: "ready", message: "signed in (config-api-key)" });

      const out = await (await open(makeDeps({ apiKey: undefined }), authority)).health();
      expect(out).toEqual({ status: "unavailable", message: NOT_SIGNED_IN });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("health is degraded when the sign-in check throws, and never includes the error text", async () => {
    const auth: AuthProvider = {
      async resolve() {
        throw new Error("secret-token-abc");
      },
      async refreshAfter401() {
        return null;
      },
    };

    const health = await (
      await open(makeDeps({}, auth), { kind: "host", operation: "status" })
    ).health();

    expect(health).toEqual({ status: "degraded", message: "sign-in check failed" });
  });

  it("health gives the sign-in check an abort signal bounded by requestTimeoutMs", async () => {
    let seen: AbortSignal | undefined;
    const auth: AuthProvider = {
      async resolve(signal) {
        seen = signal;
        return null;
      },
      async refreshAfter401() {
        return null;
      },
    };

    await (await open(makeDeps({}, auth), ownerAuthority())).health();

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("health gives up on a hung sign-in check once requestTimeoutMs has passed", async () => {
    const auth: AuthProvider = {
      resolve(signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async refreshAfter401() {
        return null;
      },
    };

    const started = Date.now();
    const health = await (
      await open(makeDeps({ requestTimeoutMs: 1000 }, auth), { kind: "host", operation: "status" })
    ).health();
    const elapsed = Date.now() - started;

    expect(health).toEqual({ status: "degraded", message: "sign-in check failed" });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  });

  it("a throwing context.assertCurrent stops search before and after the request", async () => {
    fake.on("POST", "/api/v1/memories/search", {
      body: { items: [{ memory_id: "m1", namespace: "n", content: "private text" }] },
    });

    // Revoked before the request: nothing is sent.
    const before = await open(makeDeps(), ownerAuthority(), () => {
      throw new Error("revoked before");
    });
    await expect(before.search({ query: "x" })).rejects.toThrow("revoked before");
    expect(fake.requests).toHaveLength(0);

    // Revoked while the request was in flight: the request was made, no hits come back.
    let calls = 0;
    const during = await open(makeDeps(), ownerAuthority(), () => {
      calls += 1;
      if (calls === 2) throw new Error("revoked after");
    });
    await expect(during.search({ query: "x" })).rejects.toThrow("revoked after");
    expect(fake.requests).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("a throwing context.assertCurrent stops get before and after the request", async () => {
    fake.on("GET", `/api/v1/memories/${MEMORY_ID}`, {
      body: { memory_id: MEMORY_ID, content: "t" },
    });
    const reference = { providerId: "kemory", id: MEMORY_ID };

    const before = await open(makeDeps(), ownerAuthority(), () => {
      throw new Error("revoked before");
    });
    await expect(before.get({ reference })).rejects.toThrow("revoked before");
    expect(fake.requests).toHaveLength(0);

    let calls = 0;
    const during = await open(makeDeps(), ownerAuthority(), () => {
      calls += 1;
      if (calls === 2) throw new Error("revoked after");
    });
    await expect(during.get({ reference })).rejects.toThrow("revoked after");
    expect(fake.requests).toHaveLength(1);
  });

  it("a not_found answer is withheld too when the caller was revoked during the request", async () => {
    fake.on("GET", "/api/v1/memories/gone", { status: 404, body: {} });
    let calls = 0;
    const provider = await open(makeDeps(), ownerAuthority(), () => {
      calls += 1;
      if (calls === 2) throw new Error("revoked after");
    });

    await expect(provider.get({ reference: { providerId: "kemory", id: "gone" } })).rejects.toThrow(
      "revoked after",
    );
  });
});
