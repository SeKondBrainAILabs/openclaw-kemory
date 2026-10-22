import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOT_SIGNED_IN } from "../src/auth.js";
import plugin from "../src/index.js";
import { createFakeApi } from "./helpers/fake-api.js";
import { type FakeKemory, startFakeKemory } from "./helpers/fake-kemory.js";
import { useTempHome } from "./helpers/temp-home.js";

let home: ReturnType<typeof useTempHome>;
let fake: FakeKemory;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = useTempHome();
  fake = await startFakeKemory();
  delete process.env.KEMORY_ENV;
  delete process.env.KEMORY_CONTEXT;
  delete process.env.KEMORY_AUTO_CAPTURE;
});

afterEach(async () => {
  home.restore();
  await fake.close();
  process.env = { ...savedEnv };
});

function warnings(logs: { level: string; msg: string }[]) {
  return logs.filter((l) => l.level === "warn").map((l) => l.msg);
}

describe("plugin entry", () => {
  it("register returns synchronously and registers one service", () => {
    const fakeApi = createFakeApi({ baseUrl: fake.url });

    const result: unknown = plugin.register(fakeApi.api);

    expect(result).toBeUndefined();
    expect(plugin.id).toBe("kemory");
    expect(fakeApi.services.map((s) => s.id)).toEqual(["kemory"]);
    expect(fake.requests).toHaveLength(0);
  });

  it("service start logs NOT_SIGNED_IN once at warn with no credential and nothing with an api key", async () => {
    const signedOut = createFakeApi({ baseUrl: fake.url });
    plugin.register(signedOut.api);
    await signedOut.services[0]?.start({});
    await signedOut.services[0]?.start({});
    expect(warnings(signedOut.logs)).toEqual([NOT_SIGNED_IN]);

    const signedIn = createFakeApi({ baseUrl: fake.url, apiKey: "k-123456" });
    plugin.register(signedIn.api);
    await signedIn.services[0]?.start({});
    expect(warnings(signedIn.logs)).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it("service start with an unprepared secret reference does not warn NOT_SIGNED_IN", async () => {
    const fakeApi = createFakeApi({
      baseUrl: fake.url,
      apiKey: { source: "env", provider: "default", id: "KEMORY_KEY" },
    });
    plugin.register(fakeApi.api);

    await fakeApi.services[0]?.start({});

    expect(warnings(fakeApi.logs)).toEqual([]);
    expect(fakeApi.logs.filter((l) => l.level === "info")).toHaveLength(1);
  });

  it("manifest declares kind memory, the four tools and apiKey as a secret input", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown> & {
      configSchema: { additionalProperties: boolean; properties: Record<string, unknown> };
    };

    expect(manifest.id).toBe("kemory");
    expect(manifest.kind).toBe("memory");
    expect(manifest.contracts).toEqual({
      tools: ["kemory_search", "kemory_store", "kemory_forget", "kemory_profile"],
    });
    expect(manifest.toolMetadata).toEqual({
      kemory_store: { sideEffecting: true },
      kemory_forget: { sideEffecting: true },
    });
    expect(manifest.configContracts).toEqual({
      secretInputs: { paths: [{ path: "apiKey", expected: "string", ownerKind: "capability" }] },
    });
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(Object.keys(manifest.configSchema.properties).sort()).toEqual(
      [
        "apiKey",
        "env",
        "baseUrl",
        "autoRecall",
        "autoCapture",
        "captureNamespace",
        "captureVisibility",
        "contextMaxChars",
        "contextNamespaces",
        "recallTimeoutMs",
        "requestTimeoutMs",
        "debug",
      ].sort(),
    );
  });
});
