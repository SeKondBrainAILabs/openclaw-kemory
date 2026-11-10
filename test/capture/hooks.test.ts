import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthProvider } from "../../src/auth.js";
import { registerCapture } from "../../src/capture/index.js";
import { statePath } from "../../src/capture/state.js";
import { createKemoryClient } from "../../src/client.js";
import { parseConfig } from "../../src/config.js";
import { createLog } from "../../src/log.js";
import type { PluginDeps } from "../../src/types.js";
import { VERSION } from "../../src/version.js";
import { createFakeApi, type FakeApi } from "../helpers/fake-api.js";
import { type FakeKemory, startFakeKemory } from "../helpers/fake-kemory.js";
import { useTempHome } from "../helpers/temp-home.js";

const MEMORIES_PATH = "/api/v1/memories";
const HEADER =
  "What was this OpenClaw session about? Session digest captured automatically " +
  "(mid-session, user turns only, secrets redacted, turns 1-3).\n\nchannel: telegram\n\n";

const SESSION_KEY = "agent:main:main";
const OWNER_CTX = {
  agentId: "main",
  sessionId: "s1",
  sessionKey: SESSION_KEY,
  channel: "telegram",
  memoryAudience: { kind: "owner-private" },
};

let fake: FakeKemory;
let home: ReturnType<typeof useTempHome>;

beforeEach(async () => {
  home = useTempHome();
  fake = await startFakeKemory();
  fake.on("POST", MEMORIES_PATH, { status: 201, body: { memory_id: "m1" } });
});

afterEach(async () => {
  home.restore();
  await fake.close();
});

/** A user message the way OpenClaw stores one: marked with who sent it. */
function user(content: unknown, extra: Record<string, unknown> = {}, senderIsOwner = true) {
  return { role: "user", content, __openclaw: { senderIsOwner }, ...extra };
}

function owned(...texts: string[]) {
  return texts.map((t) => user(t));
}

function setup(raw: Record<string, unknown> = {}, withKey = true) {
  const fakeApi = createFakeApi();
  const config = parseConfig(
    { baseUrl: fake.url, ...(withKey ? { apiKey: "test-key-123456" } : {}), ...raw },
    {},
  );
  const log = createLog(fakeApi.api.logger, { debug: true });
  const auth = createAuthProvider(config, { log, home: home.home });
  const client = createKemoryClient(auth, { version: VERSION });
  const deps: PluginDeps = { config, client, auth, log, home: home.home };
  registerCapture(fakeApi.api, deps);
  return fakeApi;
}

function posts() {
  return fake.requests.filter((r) => r.method === "POST" && r.path === MEMORIES_PATH);
}

function sentBody(index = 0): Record<string, unknown> {
  return posts()[index]?.json() as Record<string, unknown>;
}

function sentContent(index = 0): string {
  return String(sentBody(index).content);
}

function warnings(fakeApi: FakeApi) {
  return fakeApi.logs.filter((l) => l.level === "warn");
}

function endTurn(fakeApi: FakeApi, messages: unknown[], ctx: unknown = OWNER_CTX, success = true) {
  return fakeApi.runHook("agent_end", { messages, success }, ctx);
}

function markExists(agentId = "main", sessionKey = SESSION_KEY): boolean {
  return existsSync(statePath(home.home, agentId, sessionKey));
}

describe("capture hooks", () => {
  it("three owner prompts send one POST with the exact body", async () => {
    const fakeApi = setup();

    await endTurn(fakeApi, owned("a", "b", "c"));

    expect(posts()).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    expect(sentBody()).toEqual({
      namespace: "user:sessions",
      namespace_tag: "session-capture",
      visibility: "user-private",
      content: `${HEADER}- a\n- b\n- c`,
      content_type: "text",
      session_id: "s1",
      metadata: {
        source: "openclaw",
        capture: "auto",
        capture_kind: "incremental",
        turns: 3,
        end_reason: "agent_end",
      },
    });
    expect(fake.requests[0]?.headers["x-api-key"]).toBe("test-key-123456");
    expect(markExists()).toBe(true);
  });

  it("sends to the configured namespace and visibility, and an empty session_id without one", async () => {
    const fakeApi = setup({ captureNamespace: "team:notes", captureVisibility: "org-shared" });

    await endTurn(fakeApi, owned("a", "b", "c"), { ...OWNER_CTX, sessionId: undefined });

    expect(sentBody()).toMatchObject({
      namespace: "team:notes",
      visibility: "org-shared",
      session_id: "",
    });
  });

  it("a shared DM history sends only the owner's prompts", async () => {
    const fakeApi = setup();
    const messages = [
      user("a"),
      user("x", {}, false),
      user("b"),
      user("y", {}, false),
      user("c"),
      { role: "assistant", content: "reply" },
    ];

    await endTurn(fakeApi, messages);

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toBe(`${HEADER}- a\n- b\n- c`);
    expect(sentContent()).not.toMatch(/\bx\b|\by\b/);
  });

  it("two prompts send nothing until session_end flushes them", async () => {
    const fakeApi = setup();

    await endTurn(fakeApi, owned("a", "b"));
    expect(posts()).toHaveLength(0);
    expect(markExists()).toBe(false);

    await fakeApi.runHook(
      "session_end",
      { sessionId: "s1", sessionKey: SESSION_KEY, messageCount: 4, reason: "idle" },
      { agentId: "main", sessionId: "s1", sessionKey: SESSION_KEY },
    );

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toBe(
      "What was this OpenClaw session about? Session digest captured automatically " +
        "(at session end, user turns only, secrets redacted, turns 1-2).\n\n" +
        "channel: telegram\n\n- a\n- b",
    );
    expect(sentBody().metadata).toEqual({
      source: "openclaw",
      capture: "auto",
      capture_kind: "flush",
      turns: 2,
      end_reason: "session_end:idle",
    });
  });

  it("session_end without a reason says unknown, and only flushes its own session", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"));
    await endTurn(fakeApi, owned("p", "q"), {
      ...OWNER_CTX,
      sessionKey: "agent:main:other",
      sessionId: "s2",
    });

    await fakeApi.runHook(
      "session_end",
      { sessionId: "s2", sessionKey: "agent:main:other", messageCount: 2 },
      { agentId: "main", sessionId: "s2", sessionKey: "agent:main:other" },
    );

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toContain("- p\n- q");
    expect(sentContent()).not.toContain("- a");
    expect((sentBody().metadata as Record<string, unknown>).end_reason).toBe("session_end:unknown");
    expect(markExists("main", "agent:main:other")).toBe(true);
    expect(markExists()).toBe(false);
  });

  it("session_end drops the pending entry once its flush settles, even when the POST fails", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"));
    fake.on("POST", MEMORIES_PATH, { status: 500, body: { detail: "boom" } });

    await fakeApi.runHook(
      "session_end",
      { sessionId: "s1", sessionKey: SESSION_KEY, messageCount: 2 },
      { agentId: "main", sessionId: "s1", sessionKey: SESSION_KEY },
    );
    expect(posts()).toHaveLength(1);

    fake.on("POST", MEMORIES_PATH, { status: 201, body: { memory_id: "m1" } });
    await fakeApi.runHook("gateway_stop", {}, {});

    expect(posts()).toHaveLength(1);
  });

  it("the same messages are never sent twice", async () => {
    const fakeApi = setup();
    const messages = owned("a", "b", "c");

    await endTurn(fakeApi, messages);
    await endTurn(fakeApi, messages);
    await fakeApi.runHook("before_compaction", { messageCount: 3 }, OWNER_CTX);
    await fakeApi.runHook(
      "session_end",
      { sessionId: "s1", sessionKey: SESSION_KEY, messageCount: 3 },
      { agentId: "main", sessionId: "s1", sessionKey: SESSION_KEY },
    );
    await fakeApi.runHook("gateway_stop", {}, {});

    expect(posts()).toHaveLength(1);
  });

  it("sends only the prompts added since the last save", async () => {
    const fakeApi = setup();

    await endTurn(fakeApi, owned("a", "b", "c"));
    await endTurn(fakeApi, owned("a", "b", "c", "d", "e"));
    expect(posts()).toHaveLength(1);
    await endTurn(fakeApi, owned("a", "b", "c", "d", "e", "f"));

    expect(posts()).toHaveLength(2);
    expect(sentContent(1)).toContain("turns 4-6");
    expect(sentContent(1).endsWith("- d\n- e\n- f")).toBe(true);
  });

  it("a failed POST leaves the mark so the next turn resends", async () => {
    const fakeApi = setup();
    fake.on("POST", MEMORIES_PATH, { status: 500, body: { detail: "boom" } });

    await endTurn(fakeApi, owned("a", "b", "c"));

    expect(posts()).toHaveLength(1);
    expect(markExists()).toBe(false);
    expect(warnings(fakeApi)).toHaveLength(1);

    fake.on("POST", MEMORIES_PATH, { status: 201, body: { memory_id: "m1" } });
    await endTurn(fakeApi, owned("a", "b", "c"));

    expect(posts()).toHaveLength(2);
    expect(sentContent(1)).toBe(sentContent(0));
    expect(markExists()).toBe(true);
  });

  it("a secret in a prompt is redacted in the sent content", async () => {
    const fakeApi = setup();

    await endTurn(
      fakeApi,
      owned("set api_key=abcdef123456 here", "use sk-abcdefghijklmnopqrstu", "c"),
    );

    expect(sentContent()).toBe(`${HEADER}- set [REDACTED] here\n- use [REDACTED]\n- c`);
    expect(fake.requests[0]?.body).not.toContain("abcdef123456");
    expect(fake.requests[0]?.body).not.toContain("sk-abcdefghijklmnopqrstu");
  });

  it("metadata blocks and timestamps are not sent", async () => {
    const fakeApi = setup();
    const withBlocks = [
      "[Mon 2026-10-26 09:15 UTC] first question",
      "",
      "Sender (untrusted metadata) ⟦openclaw:ctx⟧",
      "```json",
      '{"id": "42", "name": "someone"}',
      "```",
      "",
      "Context: ⟦openclaw:ctx⟧",
      "channel: telegram",
    ].join("\n");

    await endTurn(fakeApi, [
      user(withBlocks),
      user("[Mon 2026-10-26 09:16 UTC] second question"),
      user("third question"),
    ]);

    expect(sentContent()).toBe(`${HEADER}- first question\n- second question\n- third question`);
  });

  it("conversation audience, missing audience, cron trigger, incognito key and inter_session provenance send nothing, write no state, and are not flushed later", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-abc";
    const cases: { name: string; ctx: Record<string, unknown> }[] = [
      { name: "conversation", ctx: { ...OWNER_CTX, memoryAudience: { kind: "conversation" } } },
      { name: "missing audience", ctx: { ...OWNER_CTX, memoryAudience: undefined } },
      { name: "cron trigger", ctx: { ...OWNER_CTX, trigger: "cron" } },
      { name: "incognito key", ctx: { ...OWNER_CTX, sessionKey: incognitoKey } },
      {
        name: "inter_session provenance",
        ctx: { ...OWNER_CTX, inputProvenance: { kind: "inter_session" } },
      },
      { name: "no session key", ctx: { ...OWNER_CTX, sessionKey: undefined } },
    ];

    for (const { name, ctx } of cases) {
      const fakeApi = setup();
      await endTurn(fakeApi, owned("a", "b", "c"), ctx);
      await endTurn(fakeApi, owned("a", "b"), ctx);
      await fakeApi.runHook("before_compaction", { messageCount: 2 }, ctx);
      const sessionKey = ctx.sessionKey as string | undefined;
      await fakeApi.runHook(
        "session_end",
        { sessionId: "s1", sessionKey, messageCount: 2 },
        { agentId: "main", sessionId: "s1", sessionKey },
      );
      await fakeApi.runHook("gateway_stop", {}, {});

      expect(posts(), name).toHaveLength(0);
      expect(markExists("main", SESSION_KEY), name).toBe(false);
      expect(markExists("main", incognitoKey), name).toBe(false);
      expect(warnings(fakeApi), name).toHaveLength(0);
    }
    expect(existsSync(`${home.home}/.kemory`)).toBe(false);
  });

  it("an unsuccessful agent_end sends nothing", async () => {
    const fakeApi = setup();

    await endTurn(fakeApi, owned("a", "b", "c"), OWNER_CTX, false);
    await fakeApi.runHook("gateway_stop", {}, {});

    expect(posts()).toHaveLength(0);
    expect(markExists()).toBe(false);
  });

  it("messages from other senders alone send nothing", async () => {
    const fakeApi = setup();

    await endTurn(fakeApi, [
      user("x", {}, false),
      user("y", {}, false),
      { role: "user", content: "z" },
    ]);
    await fakeApi.runHook("gateway_stop", {}, {});

    expect(posts()).toHaveLength(0);
  });

  it("before_compaction and gateway_stop flush pending prompts", async () => {
    const fakeApi = setup();

    await endTurn(fakeApi, owned("a", "b"));
    // The context OpenClaw's auto-compaction sends: the session key and nothing else.
    await fakeApi.runHook("before_compaction", { messageCount: 2 }, { sessionKey: SESSION_KEY });

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toContain("(before compaction, user turns only");
    expect(sentBody().metadata).toMatchObject({ capture_kind: "flush", end_reason: "compaction" });

    await endTurn(fakeApi, owned("p", "q"), {
      ...OWNER_CTX,
      sessionKey: "agent:main:other",
      sessionId: "s2",
    });
    await fakeApi.runHook("gateway_stop", { reason: "shutdown" }, {});

    expect(posts()).toHaveLength(2);
    const flushed = sentBody(1);
    expect(flushed.session_id).toBe("s2");
    expect(flushed.metadata).toMatchObject({
      capture_kind: "flush",
      turns: 2,
      end_reason: "gateway_stop",
    });
    expect(String(flushed.content)).toContain("(at session end, user turns only");
  });

  it("before_compaction flushes with the context queued compaction sends, which has no audience", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"));

    await fakeApi.runHook(
      "before_compaction",
      { messageCount: 2 },
      {
        sessionId: "s1",
        agentId: "main",
        sessionKey: SESSION_KEY,
        workspaceDir: "/tmp/workspace",
        messageProvider: "telegram",
      },
    );

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toContain("(before compaction, user turns only");
    expect(sentContent()).toContain("- a\n- b");
    expect(sentBody().session_id).toBe("s1");
  });

  it("before_compaction flushes only the entry of the agent it names, and keeps the entry", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"), { ...OWNER_CTX, agentId: "main" });
    await endTurn(fakeApi, owned("p", "q"), { ...OWNER_CTX, agentId: "helper" });

    await fakeApi.runHook(
      "before_compaction",
      { messageCount: 2 },
      { agentId: "helper", sessionKey: SESSION_KEY },
    );

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toContain("- p\n- q");
    expect(markExists("main")).toBe(false);

    // The entry is not deleted, so the shutdown flush still reaches it and the mark stops a resend.
    await fakeApi.runHook("gateway_stop", {}, {});
    expect(posts()).toHaveLength(2);
    expect(sentContent(1)).toContain("- a\n- b");
  });

  it("before_compaction keeps the entry, so a failed compaction flush is resent at shutdown", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"));
    fake.on("POST", MEMORIES_PATH, { status: 500, body: { detail: "boom" } });

    await fakeApi.runHook("before_compaction", { messageCount: 2 }, { sessionKey: SESSION_KEY });
    expect(posts()).toHaveLength(1);
    expect(markExists()).toBe(false);

    fake.on("POST", MEMORIES_PATH, { status: 201, body: { memory_id: "m1" } });
    await fakeApi.runHook("gateway_stop", {}, {});

    expect(posts()).toHaveLength(2);
    expect(sentContent(1)).toContain("- a\n- b");
    expect(markExists()).toBe(true);
  });

  it("before_compaction with no session key or an unknown one sends nothing", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"));

    await fakeApi.runHook("before_compaction", { messageCount: 2 }, {});
    await fakeApi.runHook("before_compaction", { messageCount: 2 }, { sessionKey: "agent:main:x" });

    expect(posts()).toHaveLength(0);
  });

  it("before_compaction sends nothing for a session whose agent_end failed the audience check", async () => {
    const fakeApi = setup();
    const conversation = { ...OWNER_CTX, memoryAudience: { kind: "conversation" } };
    await endTurn(fakeApi, owned("a", "b"), conversation);

    await fakeApi.runHook("before_compaction", { messageCount: 2 }, { sessionKey: SESSION_KEY });
    await fakeApi.runHook("before_compaction", { messageCount: 2 }, conversation);

    expect(posts()).toHaveLength(0);
    expect(markExists()).toBe(false);
  });

  it("session_end flushes only the entry of the agent it names", async () => {
    const fakeApi = setup();
    await endTurn(fakeApi, owned("a", "b"), { ...OWNER_CTX, agentId: "main" });
    await endTurn(fakeApi, owned("p", "q"), { ...OWNER_CTX, agentId: "helper" });

    await fakeApi.runHook(
      "session_end",
      { sessionId: "s1", sessionKey: SESSION_KEY, messageCount: 2 },
      { agentId: "helper", sessionId: "s1", sessionKey: SESSION_KEY },
    );

    expect(posts()).toHaveLength(1);
    expect(sentContent()).toContain("- p\n- q");
    expect(markExists("main")).toBe(false);
  });

  it("two concurrent agent_end calls for one session send one POST", async () => {
    const fakeApi = setup();
    fake.on("POST", MEMORIES_PATH, { status: 201, body: { memory_id: "m1" }, delayMs: 100 });
    const messages = owned("a", "b", "c");

    await Promise.all([endTurn(fakeApi, messages), endTurn(fakeApi, messages)]);

    expect(posts()).toHaveLength(1);
  });

  it("a slow Kemory times out within the deadline, writes no state and warns once", async () => {
    const fakeApi = setup({ requestTimeoutMs: 1000 });
    fake.on("POST", MEMORIES_PATH, { status: 201, body: {}, delayMs: 5000 });

    const started = Date.now();
    await endTurn(fakeApi, owned("a", "b", "c"));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(posts()).toHaveLength(1);
    expect(markExists()).toBe(false);
    expect(warnings(fakeApi)).toHaveLength(1);
    expect(warnings(fakeApi)[0]?.msg).toContain("capture failed");
  });

  it("not signed in sends nothing and does not warn", async () => {
    const fakeApi = setup({}, false);

    await endTurn(fakeApi, owned("a", "b", "c"));
    await fakeApi.runHook("gateway_stop", {}, {});

    expect(fake.requests).toHaveLength(0);
    expect(markExists()).toBe(false);
    expect(warnings(fakeApi)).toHaveLength(0);
    expect(fakeApi.logs.some((l) => l.level === "debug" && l.msg.includes("not signed in"))).toBe(
      true,
    );
  });

  it("autoCapture false registers no hooks", () => {
    const fakeApi = setup({ autoCapture: false });

    expect(fakeApi.hooks.size).toBe(0);
  });

  it("every hook is registered with timeoutMs requestTimeoutMs + 2000", () => {
    const fakeApi = setup({ requestTimeoutMs: 7000 });

    expect([...fakeApi.hooks.keys()].sort()).toEqual([
      "agent_end",
      "before_compaction",
      "gateway_stop",
      "session_end",
    ]);
    for (const hook of fakeApi.hooks.values()) {
      expect(hook.opts).toEqual({ timeoutMs: 9000 });
    }
  });

  it("no hook rejects when the state cannot be written", async () => {
    const fakeApi = setup();
    // A file where the .kemory directory should be makes writeState fail after a good POST.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${home.home}/.kemory`, "not a directory");

    await expect(endTurn(fakeApi, owned("a", "b", "c"))).resolves.toBeUndefined();

    expect(warnings(fakeApi)).toHaveLength(1);
  });
});
