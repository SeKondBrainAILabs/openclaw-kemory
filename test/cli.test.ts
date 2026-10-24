import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthProvider, NOT_SIGNED_IN } from "../src/auth.js";
import { registerCli, statusLines } from "../src/cli.js";
import { createKemoryClient } from "../src/client.js";
import { type KemoryConfig, parseConfig } from "../src/config.js";
import { createLog } from "../src/log.js";
import type { PluginDeps } from "../src/types.js";
import { VERSION } from "../src/version.js";
import { credentialsFixture, writeCredentialsFile } from "./helpers/credentials-file.js";
import { createFakeApi } from "./helpers/fake-api.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

let fake: FakeKemory;
let tmp: ReturnType<typeof useTempHome>;

beforeEach(async () => {
  fake = await startFakeKemory();
  tmp = useTempHome();
});

afterEach(async () => {
  await fake.close();
  tmp.restore();
});

function depsFor(raw: Record<string, unknown> = {}, tweak: Partial<KemoryConfig> = {}): PluginDeps {
  const config = { ...parseConfig({ baseUrl: fake.url, ...raw }, {}), ...tweak };
  const silent = () => undefined;
  const log = createLog(
    { debug: silent, info: silent, warn: silent, error: silent },
    { debug: false },
  );
  const auth = createAuthProvider(config, { log, home: tmp.home });
  const client = createKemoryClient(auth, { version: VERSION });
  return { config, client, auth, log, home: tmp.home };
}

function login(overrides: Record<string, unknown> = {}) {
  writeCredentialsFile(
    tmp.home,
    credentialsFixture({ issuer: fake.url, kemory_url: fake.url, ...overrides }),
  );
}

const ME = { email: "ada@example.com", org_name: "Acme" };

describe("statusLines", () => {
  it("status lines for cli-login, cli-api-key, config-api-key and not signed in", async () => {
    fake.on("GET", "/api/v1/me", { body: ME });

    login();
    expect(await statusLines(depsFor())).toEqual([
      "source: cli-login",
      "env: prod",
      `base url: ${fake.url}`,
      "organisation: org-active",
      "account: ada@example.com (Acme)",
    ]);
    expect(fake.requests.map((r) => [r.path, r.headers["x-organization-id"]])).toEqual([
      ["/api/v1/me", "org-active"],
    ]);

    login({ active_org_id: "", org_id: "" });
    expect((await statusLines(depsFor())).slice(0, 4)).toEqual([
      "source: cli-login",
      "env: prod",
      `base url: ${fake.url}`,
      "organisation: none (home organisation)",
    ]);
    expect(fake.requests[1]?.headers["x-organization-id"]).toBeUndefined();

    login({ issuer: "local", access_token: "kemory-api-key" });
    expect(await statusLines(depsFor())).toEqual([
      "source: cli-api-key",
      "env: prod",
      `base url: ${fake.url}`,
      "organisation: set by the API key",
      "account: ada@example.com (Acme)",
    ]);
    expect(fake.requests[2]?.headers["x-api-key"]).toBe("kemory-api-key");

    const before = fake.requests.length;
    writeCredentialsFile(tmp.home, credentialsFixture({ version: 1 }));
    expect(await statusLines(depsFor({ apiKey: "config-key", env: "india" }))).toEqual([
      "source: config-api-key",
      "env: india",
      `base url: ${fake.url}`,
      "organisation: set by the API key",
      "account: ada@example.com (Acme)",
    ]);
    expect(fake.requests[before]?.headers["x-api-key"]).toBe("config-key");

    const after = fake.requests.length;
    expect(await statusLines(depsFor())).toEqual(["source: none", NOT_SIGNED_IN]);
    expect(fake.requests).toHaveLength(after);
  });

  it("status shows the account from GET /api/v1/me and the error kind when it fails", async () => {
    login();

    fake.on("GET", "/api/v1/me", { body: { email: "ada@example.com" } });
    expect((await statusLines(depsFor())).at(-1)).toBe("account: ada@example.com");

    fake.on("GET", "/api/v1/me", { status: 500, body: { detail: "boom" } });
    expect((await statusLines(depsFor())).at(-1)).toBe("account: error http 500");

    fake.on("GET", "/api/v1/me", { status: 302, headers: { Location: "http://127.0.0.1:1/" } });
    expect((await statusLines(depsFor())).at(-1)).toBe("account: error redirect 302");

    fake.on("GET", "/api/v1/me", { rawBody: "<html>" });
    expect((await statusLines(depsFor())).at(-1)).toBe("account: error bad_response 200");

    fake.on("GET", "/api/v1/me", { delayMs: 800, body: ME });
    const slow = await statusLines(depsFor({}, { requestTimeoutMs: 200 }));
    expect(slow.at(-1)).toBe("account: error timeout");
    // The sign-in lines are still there for the failed account lookup.
    expect(slow[0]).toBe("source: cli-login");
  });

  it("reports a sign-in that fails on its own instead of throwing", async () => {
    login({ expires_at: Date.now() / 1000 + 30, issuer: "http://127.0.0.1:1" });

    expect(await statusLines(depsFor())).toEqual([
      "source: unknown",
      "env: prod",
      "account: error network",
    ]);
  });

  it("never prints a token or key", async () => {
    fake.on("GET", "/api/v1/me", { body: ME });
    login({ access_token: "secret-access", refresh_token: "secret-refresh" });

    const lines = (await statusLines(depsFor({ apiKey: "secret-config-key" }))).join("\n");

    expect(lines).not.toMatch(/secret-/u);
  });
});

describe("registerCli", () => {
  it("registers a kemory command with a status subcommand that prints the status lines", async () => {
    fake.on("GET", "/api/v1/me", { body: ME });
    login();
    const fakeApi = createFakeApi();
    registerCli(fakeApi.api, depsFor());

    expect(fakeApi.cliRegistrars).toHaveLength(1);
    const [{ registrar, opts }] = fakeApi.cliRegistrars as [{ registrar: unknown; opts: unknown }];
    expect(opts).toEqual({
      descriptors: [
        { name: "kemory", description: "Kemory memory: sign-in status", hasSubcommands: true },
      ],
    });

    const actions = new Map<string, () => Promise<void>>();
    const commands: string[] = [];
    const node = (path: string) => ({
      description: () => node(path),
      command(name: string) {
        commands.push(`${path}${name}`);
        return node(`${path}${name} `);
      },
      action(fn: () => Promise<void>) {
        actions.set(path.trim(), fn);
        return node(path);
      },
    });
    await (registrar as (ctx: { program: unknown }) => Promise<void> | void)({
      program: node(""),
    });
    expect(commands).toEqual(["kemory", "kemory status"]);

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await actions.get("kemory status")?.();
      expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
        "source: cli-login\n",
        "env: prod\n",
        `base url: ${fake.url}\n`,
        "organisation: org-active\n",
        "account: ada@example.com (Acme)\n",
      ]);
    } finally {
      write.mockRestore();
    }
  });
});
