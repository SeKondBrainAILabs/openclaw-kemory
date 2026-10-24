import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthProvider, REFRESH_TIMEOUT_MS } from "../src/auth.js";
import { createKemoryClient, KemoryError } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { createLog } from "../src/log.js";
import { VERSION } from "../src/version.js";
import {
  credentialsFilePath,
  credentialsFixture,
  readCredentialsFile,
  TOKEN_PATH,
  writeCredentialsFile,
} from "./helpers/credentials-file.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

const NO_ACTIVE_ORG =
  'kemory: your kemory login has no active organisation, so requests use your account\'s home organisation. Run "kemory use <org>" to choose one.';

let fake: FakeKemory;
let tmp: ReturnType<typeof useTempHome>;
let logs: { level: string; msg: string }[];

beforeEach(async () => {
  fake = await startFakeKemory();
  tmp = useTempHome();
  logs = [];
});

afterEach(async () => {
  await fake.close();
  tmp.restore();
});

function stack(raw: Record<string, unknown> = {}) {
  const config = parseConfig(raw, {});
  const log = createLog(
    {
      debug: (msg: string) => logs.push({ level: "debug", msg }),
      info: (msg: string) => logs.push({ level: "info", msg }),
      warn: (msg: string) => logs.push({ level: "warn", msg }),
      error: (msg: string) => logs.push({ level: "error", msg }),
    },
    { debug: true },
  );
  const auth = createAuthProvider(config, { log, home: tmp.home });
  return { auth, client: createKemoryClient(auth, { version: VERSION }) };
}

/** A login file whose issuer and Kemory URL are both the fake server. */
function login(overrides: Record<string, unknown> = {}, env = "prod") {
  writeCredentialsFile(
    tmp.home,
    credentialsFixture({ issuer: fake.url, kemory_url: fake.url, ...overrides }),
    env,
  );
}

const rotated = (n: number) => ({
  access_token: `access-token-${n}`,
  refresh_token: `refresh-token-${n}`,
  expires_in: 300,
});

const soon = () => Date.now() / 1000 + 30;
const API_PATH = "/api/v1/ping";

const tokenRequests = () => fake.requests.filter((r) => r.path === TOKEN_PATH);
const apiRequests = () => fake.requests.filter((r) => r.path === API_PATH);

async function failure(promise: Promise<unknown>): Promise<KemoryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(KemoryError);
    return err as KemoryError;
  }
  throw new Error("expected the request to fail");
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
}

describe("sign-in from the kemory login file", () => {
  it("oauth login sends Bearer and X-Organization-ID from active_org_id", async () => {
    login();
    fake.on("GET", API_PATH, { body: { ok: true } });
    const { client } = stack();

    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    const [req] = fake.requests;
    expect(req?.headers.authorization).toBe("Bearer access-token-one");
    expect(req?.headers["x-organization-id"]).toBe("org-active");
    expect(req?.headers["x-api-key"]).toBeUndefined();
    expect(logs.filter((l) => l.msg === NO_ACTIVE_ORG)).toEqual([]);
  });

  it("falls back to org_id and omits the header with one info log when both are empty", async () => {
    fake.on("GET", API_PATH, { body: {} });
    const { auth, client } = stack();

    login({ active_org_id: "", org_id: "org-home" });
    const home = await auth.resolve(AbortSignal.timeout(2000));
    expect(home?.orgId).toBe("org-home");
    await client.request("GET", API_PATH, { timeoutMs: 2000 });
    expect(fake.requests[0]?.headers["x-organization-id"]).toBe("org-home");

    login({ active_org_id: "", org_id: "" });
    await client.request("GET", API_PATH, { timeoutMs: 2000 });
    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(fake.requests[1]?.headers["x-organization-id"]).toBeUndefined();
    expect(fake.requests[1]?.headers.authorization).toBe("Bearer access-token-one");
    expect(fake.requests[2]?.headers["x-organization-id"]).toBeUndefined();
    expect(logs.filter((l) => l.msg === NO_ACTIVE_ORG)).toEqual([
      { level: "info", msg: NO_ACTIVE_ORG },
    ]);
  });

  it("a local issuer file sends X-API-Key and no org header", async () => {
    login({ issuer: "local", client_id: "local", access_token: "kemory-api-key" });
    fake.on("GET", API_PATH, { body: {} });
    const { auth, client } = stack();

    const resolved = await auth.resolve(AbortSignal.timeout(2000));
    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(resolved?.source).toBe("cli-api-key");
    const [req] = fake.requests;
    expect(req?.headers["x-api-key"]).toBe("kemory-api-key");
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.headers["x-organization-id"]).toBeUndefined();
    expect(tokenRequests()).toHaveLength(0);
  });

  it("a local file that has already expired is used as it is and never refreshed", async () => {
    login({ issuer: "local", access_token: "kemory-api-key", expires_at: 0 });
    fake.on("GET", API_PATH, { body: {} });
    const { client } = stack();

    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(fake.requests[0]?.headers["x-api-key"]).toBe("kemory-api-key");
  });

  it("the credentials file wins over config apiKey; env india reads credentials-india; config baseUrl beats kemory_url", async () => {
    fake.on("GET", API_PATH, { body: {} });
    login({ access_token: "prod-token" });
    login({ access_token: "india-token", active_org_id: "org-india" }, "india");

    const prod = stack({ apiKey: "config-key" });
    await prod.client.request("GET", API_PATH, { timeoutMs: 2000 });
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer prod-token");
    expect(fake.requests[0]?.headers["x-api-key"]).toBeUndefined();

    const india = stack({ env: "india" });
    const resolved = await india.auth.resolve(AbortSignal.timeout(2000));
    expect(resolved).toMatchObject({ source: "cli-login", env: "india", orgId: "org-india" });
    await india.client.request("GET", API_PATH, { timeoutMs: 2000 });
    expect(fake.requests[1]?.headers.authorization).toBe("Bearer india-token");

    // The file's kemory_url points at a host nothing listens on; config baseUrl wins.
    login({ kemory_url: "http://127.0.0.1:1" });
    const pinned = stack({ baseUrl: fake.url });
    await pinned.client.request("GET", API_PATH, { timeoutMs: 2000 });
    expect(fake.requests).toHaveLength(3);
    expect((await stack().auth.resolve(AbortSignal.timeout(2000)))?.baseUrl).toBe(
      "http://127.0.0.1:1",
    );
  });

  it("falls back to the default base URL when the file has none", async () => {
    login({ kemory_url: "" });
    const resolved = await stack().auth.resolve(AbortSignal.timeout(2000));
    expect(resolved?.baseUrl).toBe("https://api.kemory.s9n.ai");
  });

  it("uses the config key when there is no login file, and nothing when there is no key either", async () => {
    const withKey = await stack({ apiKey: "config-key" }).auth.resolve(AbortSignal.timeout(2000));
    expect(withKey).toMatchObject({
      source: "config-api-key",
      headers: { "X-API-Key": "config-key" },
    });

    const { client } = stack();
    expect((await failure(client.request("GET", API_PATH, { timeoutMs: 2000 }))).kind).toBe(
      "not_signed_in",
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("refreshing the login", () => {
  it("a token within 60 s of expiry is refreshed and the rotated tokens are written back", async () => {
    login({ expires_at: soon(), zzz_unknown: "kept" });
    fake.on("POST", TOKEN_PATH, { body: rotated(2) });
    fake.on("GET", API_PATH, { body: {} });
    const { client } = stack();
    const before = Date.now() / 1000;

    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(tokenRequests()).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(tokenRequests()[0]?.body))).toEqual({
      client_id: "kemory-cli",
      grant_type: "refresh_token",
      refresh_token: "refresh-token-one",
    });
    expect(apiRequests()[0]?.headers.authorization).toBe("Bearer access-token-2");
    const file = readCredentialsFile(tmp.home);
    expect(file).toMatchObject({
      access_token: "access-token-2",
      refresh_token: "refresh-token-2",
      zzz_unknown: "kept",
      active_org_id: "org-active",
    });
    expect(file.expires_at as number).toBeGreaterThanOrEqual(before + 300);

    // The next call reads the fresh file and does not refresh again.
    await client.request("GET", API_PATH, { timeoutMs: 2000 });
    expect(tokenRequests()).toHaveLength(1);
  });

  it("five concurrent requests trigger exactly one refresh", async () => {
    login({ expires_at: soon() });
    fake.on("POST", TOKEN_PATH, { delayMs: 150, body: rotated(2) });
    fake.on("GET", API_PATH, { body: {} });
    const { client } = stack();

    await Promise.all(
      Array.from({ length: 5 }, () => client.request("GET", API_PATH, { timeoutMs: 3000 })),
    );

    expect(tokenRequests()).toHaveLength(1);
    expect(apiRequests()).toHaveLength(5);
    for (const req of apiRequests()) {
      expect(req.headers.authorization).toBe("Bearer access-token-2");
    }
    expect(readCredentialsFile(tmp.home).refresh_token).toBe("refresh-token-2");
  });

  it("a caller's short deadline does not abort a refresh in flight, and the rotated tokens are still written back", async () => {
    login({ expires_at: soon() });
    fake.on("POST", TOKEN_PATH, { delayMs: 800, body: rotated(2) });
    fake.on("GET", API_PATH, { body: {} });
    const { client } = stack();
    const started = Date.now();

    const err = await failure(client.request("GET", API_PATH, { timeoutMs: 300 }));

    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(600);
    expect(apiRequests()).toHaveLength(0);
    await waitFor(() => readCredentialsFile(tmp.home).refresh_token === "refresh-token-2");
    expect(readCredentialsFile(tmp.home).access_token).toBe("access-token-2");
    expect(tokenRequests()).toHaveLength(1);
  });

  it("a slow issuer counts against the request deadline", async () => {
    login({ expires_at: soon() });
    fake.on("POST", TOKEN_PATH, { delayMs: 1500, body: rotated(2) });
    const { client } = stack();
    const started = Date.now();

    const err = await failure(client.request("GET", API_PATH, { timeoutMs: 200 }));

    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(700);
    expect(REFRESH_TIMEOUT_MS).toBe(10000);
  });

  it("a rejected refresh uses a file another process refreshed meanwhile", async () => {
    login({ expires_at: soon() });
    fake.on("GET", API_PATH, { body: {} });
    // While the issuer answers, the CLI rotates the file and our token is refused.
    fake.on("POST", TOKEN_PATH, () => {
      login({ access_token: "from-the-cli", refresh_token: "cli-refresh" });
      return { status: 400, body: { error: "invalid_grant" } };
    });
    const { client } = stack({ apiKey: "config-key" });

    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(tokenRequests()).toHaveLength(1);
    expect(apiRequests()[0]?.headers.authorization).toBe("Bearer from-the-cli");
    expect(apiRequests()[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("a rejected refresh with no newer file falls back to config apiKey, else not_signed_in", async () => {
    login({ expires_at: soon() });
    fake.on("POST", TOKEN_PATH, { status: 400, body: { error: "invalid_grant" } });
    fake.on("GET", API_PATH, { body: {} });

    const withKey = stack({ apiKey: "config-key", baseUrl: fake.url });
    await withKey.client.request("GET", API_PATH, { timeoutMs: 2000 });
    // The issuer was asked, and its refusal is what sent the call to the config key.
    expect(tokenRequests()).toHaveLength(1);
    expect(apiRequests()[0]?.headers["x-api-key"]).toBe("config-key");
    expect(apiRequests()[0]?.headers.authorization).toBeUndefined();

    const without = stack();
    const err = await failure(without.client.request("GET", API_PATH, { timeoutMs: 2000 }));
    expect(err.kind).toBe("not_signed_in");
    expect(tokenRequests()).toHaveLength(2);
    expect(apiRequests()).toHaveLength(1);
    // The file is left alone for the CLI to sort out.
    expect(readCredentialsFile(tmp.home).refresh_token).toBe("refresh-token-one");
  });

  it("a rejected refresh whose file changed but is still about to expire counts as signed out", async () => {
    login({ expires_at: soon() });
    fake.on("POST", TOKEN_PATH, () => {
      login({ refresh_token: "cli-refresh", expires_at: soon() });
      return { status: 400, body: {} };
    });
    const { auth } = stack();

    expect(await auth.resolve(AbortSignal.timeout(2000))).toBeNull();
    expect(tokenRequests()).toHaveLength(1);
  });

  it("an unreachable issuer rejects the request as a network error and keeps the file", async () => {
    login({ expires_at: soon(), issuer: "http://127.0.0.1:1" });
    const { client } = stack({ apiKey: "config-key" });

    const err = await failure(client.request("GET", API_PATH, { timeoutMs: 2000 }));

    expect(err.kind).toBe("network");
    expect(readCredentialsFile(tmp.home).refresh_token).toBe("refresh-token-one");
  });

  it("a failed write-back is logged without tokens and the new tokens still serve the call", async () => {
    login({ expires_at: soon() });
    const target = credentialsFilePath(tmp.home);
    fake.on("POST", TOKEN_PATH, () => {
      // Turn the file into a directory so the rename cannot replace it.
      rmSync(target);
      mkdirSync(target);
      return { body: rotated(2) };
    });
    fake.on("GET", API_PATH, { body: {} });
    const { client } = stack();

    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(apiRequests()[0]?.headers.authorization).toBe("Bearer access-token-2");
    expect(
      logs.some((l) => l.level === "warn" && l.msg.startsWith("kemory: credentials-write")),
    ).toBe(true);
  });
});

describe("a 401 from the API", () => {
  it("a 401 forces one refresh and one retry; a second 401 fails after two API requests", async () => {
    login();
    fake.on("POST", TOKEN_PATH, { body: rotated(2) });
    fake.on("GET", API_PATH, { status: 401, body: { detail: "expired" } });
    const { client } = stack();

    const err = await failure(client.request("GET", API_PATH, { timeoutMs: 2000 }));

    expect(err).toMatchObject({ kind: "http", status: 401 });
    expect(apiRequests()).toHaveLength(2);
    expect(tokenRequests()).toHaveLength(1);
    expect(apiRequests()[0]?.headers.authorization).toBe("Bearer access-token-one");
    expect(apiRequests()[1]?.headers.authorization).toBe("Bearer access-token-2");
    expect(readCredentialsFile(tmp.home).refresh_token).toBe("refresh-token-2");
  });

  it("a 401 retries with the token another process already refreshed, without calling the issuer", async () => {
    login();
    let calls = 0;
    fake.on("GET", API_PATH, () => {
      calls += 1;
      if (calls === 1) {
        login({ access_token: "from-the-cli", refresh_token: "cli-refresh" });
        return { status: 401, body: {} };
      }
      return { body: { ok: true } };
    });
    const { client } = stack();

    await client.request("GET", API_PATH, { timeoutMs: 2000 });

    expect(tokenRequests()).toHaveLength(0);
    expect(apiRequests()[1]?.headers.authorization).toBe("Bearer from-the-cli");
  });

  it("is not retried for a key from the login file or the config", async () => {
    fake.on("GET", API_PATH, { status: 401, body: {} });

    login({ issuer: "local", access_token: "kemory-api-key" });
    await failure(stack().client.request("GET", API_PATH, { timeoutMs: 2000 }));
    expect(apiRequests()).toHaveLength(1);

    rmSync(credentialsFilePath(tmp.home));
    await failure(
      stack({ apiKey: "k", baseUrl: fake.url }).client.request("GET", API_PATH, {
        timeoutMs: 2000,
      }),
    );
    expect(apiRequests()).toHaveLength(2);
    expect(tokenRequests()).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("tokens never appear in logs or error messages", async () => {
    const secrets = [
      "access-token-one",
      "refresh-token-one",
      "access-token-2",
      "refresh-token-2",
      "config-key",
    ];
    const seen: string[] = [];
    const record = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (err) {
        seen.push(String((err as Error).message), String(err));
      }
    };
    fake.on("GET", API_PATH, { status: 401, body: {} });
    fake.on("POST", TOKEN_PATH, { body: rotated(2) });

    login({ expires_at: soon() });
    await record(
      stack({ apiKey: "config-key" }).client.request("GET", API_PATH, { timeoutMs: 2000 }),
    );

    fake.on("POST", TOKEN_PATH, { status: 400, body: { error: "refresh-token-one" } });
    login({ expires_at: soon(), issuer: "http://127.0.0.1:1" });
    await record(stack().client.request("GET", API_PATH, { timeoutMs: 2000 }));

    login({ expires_at: soon() });
    await record(stack().client.request("GET", API_PATH, { timeoutMs: 2000 }));

    // A file the plugin cannot write back, with the new tokens in hand.
    login();
    fake.on("POST", TOKEN_PATH, { body: rotated(2) });
    chmodSync(`${tmp.home}/.kemory`, 0o500);
    await record(stack().client.request("GET", API_PATH, { timeoutMs: 2000 }));
    chmodSync(`${tmp.home}/.kemory`, 0o700);

    const output = [...seen, ...logs.map((l) => l.msg)].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});
