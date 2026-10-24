import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliCredentials,
  credentialsPath,
  isApiKeyCredentials,
  readCredentials,
  refreshCredentials,
  writeCredentials,
} from "../src/credentials.js";
import { credentialsFixture, readCredentialsFile, TOKEN_PATH } from "./helpers/credentials-file.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

let tmp: ReturnType<typeof useTempHome>;
let home: string;

beforeEach(() => {
  tmp = useTempHome();
  home = tmp.home;
});

afterEach(() => {
  tmp.restore();
});

function writeRaw(text: string, env = "prod") {
  mkdirSync(join(home, ".kemory"), { recursive: true });
  writeFileSync(credentialsPath(home, env), text);
}

describe("readCredentials", () => {
  it("reads a version 2 file and ignores trailing bytes after the first JSON object", async () => {
    const fixture = credentialsFixture({ expires_at: 1729512345.123456, extra: { a: "}" } });
    // Leading whitespace, a brace and an escaped quote inside strings, then leftovers
    // from a longer file that was overwritten in place.
    writeRaw(
      `\n  ${JSON.stringify({ ...fixture, email: 'a"}b@example.com' }, null, 2)}  \n"tail": 1}}\x00junk`,
    );

    const creds = await readCredentials(home, "prod");

    expect(creds).toMatchObject({
      version: 2,
      access_token: "access-token-one",
      refresh_token: "refresh-token-one",
      expires_at: 1729512345.123456,
      client_id: "kemory-cli",
      email: 'a"}b@example.com',
      active_org_id: "org-active",
      extra: { a: "}" },
    });
  });

  it("a missing required key, version 1, invalid JSON or a missing file reads as null", async () => {
    expect(await readCredentials(home, "prod")).toBeNull();

    writeRaw("not json");
    expect(await readCredentials(home, "prod")).toBeNull();

    writeRaw('{"version": 2, "access_token": "x"');
    expect(await readCredentials(home, "prod")).toBeNull();

    writeRaw(JSON.stringify(credentialsFixture({ version: 1 })));
    expect(await readCredentials(home, "prod")).toBeNull();

    for (const key of [
      "access_token",
      "refresh_token",
      "expires_at",
      "issuer",
      "client_id",
      "kemory_url",
    ]) {
      const fixture = credentialsFixture();
      delete fixture[key];
      writeRaw(JSON.stringify(fixture));
      expect(await readCredentials(home, "prod"), `without ${key}`).toBeNull();
    }

    // Empty values are allowed: the CLI writes them for an API-key login.
    writeRaw(JSON.stringify(credentialsFixture({ refresh_token: "", kemory_url: "" })));
    expect(await readCredentials(home, "prod")).not.toBeNull();
  });

  it("rewrites old hosts and issuer in memory", async () => {
    for (const old of ["https://api.kemory.sekondbrain.ai", "https://kemory.prod.apps.s9n.ai"]) {
      writeRaw(
        JSON.stringify(
          credentialsFixture({
            kemory_url: old,
            issuer: "https://accounts.prod.apps.s9n.ai/realms/s9n",
          }),
        ),
      );
      const creds = await readCredentials(home, "prod");
      expect(creds?.kemory_url).toBe("https://api.kemory.s9n.ai");
      expect(creds?.issuer).toBe("https://accounts.sekondbrain.ai/realms/s9n");
    }

    writeRaw(JSON.stringify(credentialsFixture({ kemory_url: "https://example.test" })));
    expect((await readCredentials(home, "prod"))?.kemory_url).toBe("https://example.test");
  });

  it("reads credentials-<env> for the env it is given and ignores an env that is not a plain name", async () => {
    writeRaw(JSON.stringify(credentialsFixture({ access_token: "india-token" })), "india");
    expect((await readCredentials(home, "india"))?.access_token).toBe("india-token");
    expect(await readCredentials(home, "prod")).toBeNull();
    expect(await readCredentials(home, "../x")).toBeNull();
    expect(() => credentialsPath(home, "a/b")).toThrow();
  });
});

describe("isApiKeyCredentials", () => {
  it("is true when the issuer or the client id is local", () => {
    const base = credentialsFixture() as CliCredentials;
    expect(isApiKeyCredentials(base)).toBe(false);
    expect(isApiKeyCredentials({ ...base, issuer: "local" })).toBe(true);
    expect(isApiKeyCredentials({ ...base, client_id: "local" })).toBe(true);
  });
});

describe("writeCredentials", () => {
  it("writes atomically with mode 0600 in a 0700 dir, sorted keys, unknown keys kept, no temp file left", async () => {
    const creds = credentialsFixture({
      version: 1,
      zzz_unknown: { nested: true },
    }) as CliCredentials;

    await writeCredentials(home, "prod", creds);

    const dir = join(home, ".kemory");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(credentialsPath(home, "prod")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["credentials-prod"]);

    const text = readFileSync(credentialsPath(home, "prod"), "utf8");
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys).toEqual([...keys].sort());
    expect(text).toContain('\n  "access_token": "access-token-one"');
    const written = readCredentialsFile(home);
    expect(written.version).toBe(2);
    expect(written.zzz_unknown).toEqual({ nested: true });
    expect(written.expires_at).toBe(creds.expires_at);
    expect(await readCredentials(home, "prod")).toEqual({ ...creds, version: 2 });
  });

  it("removes its temp file when the rename fails", async () => {
    // A directory at the target makes the rename fail after the temp file exists.
    const dir = join(home, ".kemory");
    mkdirSync(join(dir, "credentials-india"), { recursive: true });

    await expect(
      writeCredentials(home, "india", credentialsFixture() as CliCredentials),
    ).rejects.toThrow();

    expect(readdirSync(dir)).toEqual(["credentials-india"]);
  });
});

describe("refreshCredentials", () => {
  let issuer: FakeKemory;

  beforeEach(async () => {
    issuer = await startFakeKemory();
  });

  afterEach(async () => {
    await issuer.close();
  });

  const creds = (overrides: Record<string, unknown> = {}) =>
    credentialsFixture({ issuer: `${issuer.url}/`, ...overrides }) as CliCredentials;

  it("refresh posts the form to <issuer>/protocol/openid-connect/token and keeps the old refresh token when none is returned", async () => {
    issuer.on("POST", TOKEN_PATH, { body: { access_token: "new-access", expires_in: 120 } });
    const before = Date.now() / 1000;

    const next = await refreshCredentials(creds(), AbortSignal.timeout(2000));

    const [req] = issuer.requests;
    expect(issuer.requests).toHaveLength(1);
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe(TOKEN_PATH);
    expect(req?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(req?.body))).toEqual({
      client_id: "kemory-cli",
      grant_type: "refresh_token",
      refresh_token: "refresh-token-one",
    });
    expect(next?.access_token).toBe("new-access");
    expect(next?.refresh_token).toBe("refresh-token-one");
    expect(next?.expires_at).toBeGreaterThanOrEqual(before + 120);
    expect(next?.expires_at).toBeLessThan(before + 125);
    // Everything else, including keys this plugin does not know, is carried over.
    expect(next?.email).toBe("ada@example.com");
  });

  it("takes a rotated refresh token and defaults the lifetime to 300 seconds", async () => {
    issuer.on("POST", TOKEN_PATH, { body: { access_token: "a2", refresh_token: "r2" } });
    const before = Date.now() / 1000;

    const next = await refreshCredentials(creds(), AbortSignal.timeout(2000));

    expect(next?.refresh_token).toBe("r2");
    expect(next?.expires_at).toBeGreaterThanOrEqual(before + 300);
    expect(next?.expires_at).toBeLessThan(before + 305);
  });

  it("returns null for a rejection, a redirect or a reply without an access token", async () => {
    issuer.on("POST", TOKEN_PATH, { status: 400, body: { error: "invalid_grant" } });
    expect(await refreshCredentials(creds(), AbortSignal.timeout(2000))).toBeNull();

    issuer.on("POST", TOKEN_PATH, {
      status: 302,
      headers: { Location: `${issuer.url}/elsewhere` },
    });
    expect(await refreshCredentials(creds(), AbortSignal.timeout(2000))).toBeNull();
    expect(issuer.requests.map((r) => r.path)).not.toContain("/elsewhere");

    issuer.on("POST", TOKEN_PATH, { body: { refresh_token: "r" } });
    expect(await refreshCredentials(creds(), AbortSignal.timeout(2000))).toBeNull();

    issuer.on("POST", TOKEN_PATH, { rawBody: "<html>" });
    expect(await refreshCredentials(creds(), AbortSignal.timeout(2000))).toBeNull();
  });

  it("throws when the signal aborts or the issuer cannot be reached", async () => {
    issuer.on("POST", TOKEN_PATH, { delayMs: 500, body: { access_token: "late" } });
    await expect(refreshCredentials(creds(), AbortSignal.timeout(100))).rejects.toThrow();

    const closed = creds({ issuer: "http://127.0.0.1:1" });
    await expect(refreshCredentials(closed, AbortSignal.timeout(2000))).rejects.toThrow();
  });
});
