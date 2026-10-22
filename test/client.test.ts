import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Auth, type AuthProvider, createAuthProvider } from "../src/auth.js";
import { createKemoryClient, KemoryError } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { createLog } from "../src/log.js";
import { VERSION } from "../src/version.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";

const KEY = "kemory-secret-key-123";

let fake: FakeKemory;
let logs: { level: string; msg: string }[];

beforeEach(async () => {
  fake = await startFakeKemory();
  logs = [];
});

afterEach(async () => {
  await fake.close();
});

function testLog() {
  return createLog(
    {
      debug: (msg: string) => logs.push({ level: "debug", msg }),
      info: (msg: string) => logs.push({ level: "info", msg }),
      warn: (msg: string) => logs.push({ level: "warn", msg }),
      error: (msg: string) => logs.push({ level: "error", msg }),
    },
    { debug: true },
  );
}

function clientFor(raw: Record<string, unknown>, readSecretApiKey?: () => string | undefined) {
  const config = parseConfig({ baseUrl: fake.url, ...raw }, {});
  const auth = createAuthProvider(config, {
    log: testLog(),
    home: "/nonexistent",
    readSecretApiKey,
  });
  return createKemoryClient(auth, { version: VERSION });
}

async function failure(promise: Promise<unknown>): Promise<KemoryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(KemoryError);
    return err as KemoryError;
  }
  throw new Error("expected the request to fail");
}

describe("client.request", () => {
  it("config api key is sent as X-API-Key with User-Agent and no Authorization or org header", async () => {
    fake.on("GET", "/api/v1/ping", { body: { ok: true } });
    const client = clientFor({ apiKey: KEY });

    const res = await client.request("GET", "/api/v1/ping", { timeoutMs: 2000 });

    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [req] = fake.requests;
    expect(req?.headers["x-api-key"]).toBe(KEY);
    expect(req?.headers["user-agent"]).toBe(`openclaw-kemory/${VERSION}`);
    expect(req?.headers.accept).toBe("application/json");
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.headers["x-organization-id"]).toBeUndefined();
    expect(req?.headers["x-kemory-client"]).toBeUndefined();
    expect(req?.headers["content-type"]).toBeUndefined();
  });

  it("a secret-reference api key is read on every request, never cached, and a missing one is not_signed_in with one info log", async () => {
    fake.on("GET", "/p", { body: {} });
    let value: string | undefined = "first-key";
    let reads = 0;
    const client = clientFor({ apiKey: { source: "env", provider: "default", id: "K" } }, () => {
      reads += 1;
      return value;
    });

    await client.request("GET", "/p", { timeoutMs: 2000 });
    value = "second-key";
    await client.request("GET", "/p", { timeoutMs: 2000 });
    expect(reads).toBe(2);
    expect(fake.requests.map((r) => r.headers["x-api-key"])).toEqual(["first-key", "second-key"]);

    value = undefined;
    const first = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));
    const second = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));
    expect(first.kind).toBe("not_signed_in");
    expect(second.kind).toBe("not_signed_in");
    expect(fake.requests).toHaveLength(2);
    expect(
      logs.filter((l) => l.level === "info" && l.msg.includes("secret reference")),
    ).toHaveLength(1);
  });

  it("a prepared secret beats the plaintext OpenClaw resolved into pluginConfig, on every request", async () => {
    fake.on("GET", "/p", { body: {} });
    let value: string | undefined = "KEY-ONE";
    const client = clientFor({ apiKey: "KEY-STALE" }, () => value);

    await client.request("GET", "/p", { timeoutMs: 2000 });
    value = "KEY-TWO";
    await client.request("GET", "/p", { timeoutMs: 2000 });

    expect(fake.requests.map((r) => r.headers["x-api-key"])).toEqual(["KEY-ONE", "KEY-TWO"]);
  });

  it("once a prepared secret has been seen, an unavailable one never falls back to the plaintext config key", async () => {
    fake.on("GET", "/p", { body: {} });
    let value: string | undefined = "KEY-ONE";
    const client = clientFor({ apiKey: "KEY-STALE" }, () => value);
    await client.request("GET", "/p", { timeoutMs: 2000 });

    value = undefined;
    const err = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));

    expect(err.kind).toBe("not_signed_in");
    expect(fake.requests).toHaveLength(1);
    expect(
      logs.filter((l) => l.level === "info" && l.msg.includes("secret reference")),
    ).toHaveLength(1);
  });

  it("a plain string apiKey is used when the host has no prepared secret for it", async () => {
    fake.on("GET", "/p", { body: {} });
    const client = clientFor({ apiKey: KEY }, () => undefined);

    await client.request("GET", "/p", { timeoutMs: 2000 });

    expect(fake.requests[0]?.headers["x-api-key"]).toBe(KEY);
    expect(logs.filter((l) => l.msg.includes("secret reference"))).toHaveLength(0);
  });

  it("a throwing secret read is not_signed_in and never throws out of the client as anything else", async () => {
    const client = clientFor({ apiKey: { source: "env", provider: "default", id: "K" } }, () => {
      throw new Error("no prepared snapshot");
    });
    const err = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));
    expect(err.kind).toBe("not_signed_in");
    expect(fake.requests).toHaveLength(0);
  });

  it("POST sends a JSON body with Content-Type application/json", async () => {
    fake.on("POST", "/api/v1/memories", { status: 201, body: { memory_id: "m1" } });
    const client = clientFor({ apiKey: KEY });

    const res = await client.request("POST", "/api/v1/memories", {
      body: { content: "hello", n: 1 },
      timeoutMs: 2000,
    });

    expect(res.status).toBe(201);
    const [req] = fake.requests;
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.json()).toEqual({ content: "hello", n: 1 });
  });

  it("builds the URL from baseUrl without trailing slashes", async () => {
    fake.on("GET", "/x", { body: {} });
    const config = parseConfig({ apiKey: KEY }, {});
    const auth: AuthProvider = {
      resolve: async () => ({
        source: "config-api-key",
        env: config.env,
        baseUrl: `${fake.url}///`,
        headers: { "X-API-Key": KEY },
      }),
      refreshAfter401: async () => null,
    };
    const res = await createKemoryClient(auth, { version: VERSION }).request("GET", "/x", {
      timeoutMs: 2000,
    });
    expect(res.status).toBe(200);
  });

  it("a slow server rejects with kind timeout within the deadline", async () => {
    fake.on("GET", "/slow", { body: {}, delayMs: 2000 });
    const client = clientFor({ apiKey: KEY });

    const started = Date.now();
    const err = await failure(client.request("GET", "/slow", { timeoutMs: 300 }));

    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it("a 302 is not followed and rejects with kind redirect", async () => {
    fake.on("GET", "/moved", { status: 302, headers: { Location: `${fake.url}/target` } });
    fake.on("GET", "/target", { body: { leaked: true } });
    const client = clientFor({ apiKey: KEY });

    const err = await failure(client.request("GET", "/moved", { timeoutMs: 2000 }));

    expect(err.kind).toBe("redirect");
    expect(err.status).toBe(302);
    expect(fake.requests.map((r) => r.path)).toEqual(["/moved"]);
  });

  it("a 500 rejects with kind http, status 500 and the parsed body", async () => {
    fake.on("GET", "/boom", { status: 500, body: { detail: "broken" } });
    const client = clientFor({ apiKey: KEY });

    const err = await failure(client.request("GET", "/boom", { timeoutMs: 2000 }));

    expect(err.kind).toBe("http");
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ detail: "broken" });
  });

  it("keeps the raw text as the error body when a failing reply is not JSON", async () => {
    fake.on("GET", "/gateway", {
      status: 502,
      rawBody: "bad gateway",
      headers: { "Content-Type": "text/plain" },
    });
    const err = await failure(
      clientFor({ apiKey: KEY }).request("GET", "/gateway", { timeoutMs: 2000 }),
    );
    expect(err.status).toBe(502);
    expect(err.body).toBe("bad gateway");
  });

  it("a 200 with invalid JSON rejects with kind bad_response and a 204 resolves with no body", async () => {
    fake.on("GET", "/junk", { rawBody: "{not json" });
    fake.on("DELETE", "/gone", { status: 204 });
    const client = clientFor({ apiKey: KEY });

    const err = await failure(client.request("GET", "/junk", { timeoutMs: 2000 }));
    expect(err.kind).toBe("bad_response");

    const res = await client.request("DELETE", "/gone", { timeoutMs: 2000 });
    expect(res).toEqual({ status: 204, body: undefined });
  });

  it("a refused connection rejects with kind network", async () => {
    const dead = await startFakeKemory();
    const url = dead.url;
    await dead.close();
    const config = parseConfig({ apiKey: KEY, baseUrl: url }, {});
    const auth = createAuthProvider(config, { log: testLog(), home: "/nonexistent" });
    const err = await failure(
      createKemoryClient(auth, { version: VERSION }).request("GET", "/p", { timeoutMs: 2000 }),
    );
    expect(err.kind).toBe("network");
  });

  it("no credential rejects with kind not_signed_in and sends no request", async () => {
    const client = clientFor({});

    const err = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));

    expect(err.kind).toBe("not_signed_in");
    expect(fake.requests).toHaveLength(0);
  });

  it("a 401 with a config api key is not retried", async () => {
    fake.on("GET", "/p", { status: 401, body: { detail: "nope" } });
    const client = clientFor({ apiKey: KEY });

    const err = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));

    expect(err.kind).toBe("http");
    expect(err.status).toBe(401);
    expect(fake.requests).toHaveLength(1);
  });

  it("only a 401 asks for a refresh", async () => {
    fake.on("GET", "/p", { status: 500 });
    let refreshes = 0;
    const auth: AuthProvider = {
      resolve: async () => ({ source: "cli-login", env: "prod", baseUrl: fake.url, headers: {} }),
      refreshAfter401: async () => {
        refreshes += 1;
        return null;
      },
    };
    const client = createKemoryClient(auth, { version: VERSION });

    const err = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));

    expect(err.status).toBe(500);
    expect(refreshes).toBe(0);
  });

  it("every 3xx is a redirect and a 400 is an http error", async () => {
    const client = clientFor({ apiKey: KEY });
    for (const status of [301, 303, 304, 307, 308]) {
      fake.on("GET", "/p", { status, headers: { Location: "http://127.0.0.1:1/elsewhere" } });
      expect((await failure(client.request("GET", "/p", { timeoutMs: 2000 }))).kind).toBe(
        "redirect",
      );
    }
    fake.on("GET", "/p", { status: 400 });
    expect((await failure(client.request("GET", "/p", { timeoutMs: 2000 }))).kind).toBe("http");
  });

  it("credential headers cannot override Accept, User-Agent or Content-Type", async () => {
    fake.on("POST", "/p", { body: {} });
    const auth: AuthProvider = {
      resolve: async () => ({
        source: "config-api-key",
        env: "prod",
        baseUrl: fake.url,
        headers: {
          Accept: "text/html",
          "User-Agent": "other/1",
          "Content-Type": "text/plain",
          "X-API-Key": KEY,
        },
      }),
      refreshAfter401: async () => null,
    };
    const client = createKemoryClient(auth, { version: VERSION });

    await client.request("POST", "/p", { body: { a: 1 }, timeoutMs: 2000 });

    const [req] = fake.requests;
    expect(req?.headers.accept).toBe("application/json");
    expect(req?.headers["user-agent"]).toBe(`openclaw-kemory/${VERSION}`);
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["x-api-key"]).toBe(KEY);
  });

  it("a route function that throws is answered with a 500 instead of hanging", async () => {
    fake.on("GET", "/boom", () => {
      throw new Error("route bug");
    });
    const client = clientFor({ apiKey: KEY });

    const err = await failure(client.request("GET", "/boom", { timeoutMs: 2000 }));

    expect(err.status).toBe(500);
  });

  it("a 401 retries once with the refreshed auth and a second 401 is final", async () => {
    fake.on("GET", "/p", (req) =>
      req.headers.authorization === "Bearer new" ? { body: { ok: true } } : { status: 401 },
    );
    const make = (token: string): Auth => ({
      source: "cli-login",
      env: "prod",
      baseUrl: fake.url,
      headers: { Authorization: `Bearer ${token}` },
    });
    let refreshes = 0;
    const auth: AuthProvider = {
      resolve: async () => make("old"),
      refreshAfter401: async () => {
        refreshes += 1;
        return make("new");
      },
    };
    const client = createKemoryClient(auth, { version: VERSION });
    expect((await client.request("GET", "/p", { timeoutMs: 2000 })).body).toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(fake.requests).toHaveLength(2);

    fake.requests.length = 0;
    fake.on("GET", "/p", { status: 401 });
    const err = await failure(client.request("GET", "/p", { timeoutMs: 2000 }));
    expect(err.status).toBe(401);
    expect(fake.requests).toHaveLength(2);
  });

  it("one deadline covers a refresh that is still running", async () => {
    fake.on("GET", "/p", { status: 401 });
    const auth: AuthProvider = {
      resolve: async () => ({
        source: "cli-login",
        env: "prod",
        baseUrl: fake.url,
        headers: { Authorization: "Bearer old" },
      }),
      refreshAfter401: (_failed, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    };
    const err = await failure(
      createKemoryClient(auth, { version: VERSION }).request("GET", "/p", { timeoutMs: 200 }),
    );
    expect(err.kind).toBe("timeout");
  });

  it("the deadline holds when auth.resolve ignores the signal", async () => {
    const auth: AuthProvider = {
      resolve: () => new Promise(() => {}),
      refreshAfter401: async () => null,
    };

    const started = Date.now();
    const err = await failure(
      createKemoryClient(auth, { version: VERSION }).request("GET", "/p", { timeoutMs: 200 }),
    );

    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake.requests).toHaveLength(0);
  });

  it("the api key never appears in an error message", async () => {
    fake.on("GET", "/boom", { status: 500, body: { detail: "broken" } });
    fake.on("GET", "/denied", { status: 401 });
    const client = clientFor({ apiKey: KEY });

    const errors = [
      await failure(client.request("GET", "/boom", { timeoutMs: 2000 })),
      await failure(client.request("GET", "/denied", { timeoutMs: 2000 })),
    ];

    for (const err of errors) {
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain("GET");
    }
    expect(errors[0]?.message).toBe("kemory http: GET /boom -> 500");
    expect(logs.map((l) => l.msg).join("\n")).not.toContain(KEY);
  });
});
