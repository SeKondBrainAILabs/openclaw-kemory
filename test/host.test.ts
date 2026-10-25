import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { createFakeApi } from "./helpers/fake-api.js";
import { useTempHome } from "./helpers/temp-home.js";

type Capability = Parameters<typeof registerMemoryCapability>[1];
type ProviderKind = (cfg: unknown) => "native" | "legacy" | undefined;

// OpenClaw does not export this classifier. It is what decides whether a turn is
// given a memory audience, so the test reaches it through the built chunk.
async function loadProviderKindResolver(): Promise<ProviderKind> {
  const sdkEntry = fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/memory-host-core"));
  const distDir = dirname(dirname(sdkEntry));
  const chunk = readdirSync(distDir).find((name) => /^memory-state-.*\.mjs$/u.test(name));
  if (!chunk) throw new Error(`no memory-state chunk under ${distDir}`);
  const mod = (await import(pathToFileURL(`${distDir}/${chunk}`).href)) as Record<string, unknown>;
  const resolver = Object.values(mod).find(
    (value) => typeof value === "function" && value.name === "resolveLoadedMemoryProviderKind",
  );
  if (typeof resolver !== "function") throw new Error("resolveLoadedMemoryProviderKind not found");
  return resolver as ProviderKind;
}

const CONFIG = { plugins: { slots: { memory: "kemory" } } };

let home: ReturnType<typeof useTempHome>;

beforeEach(() => {
  home = useTempHome();
  clearMemoryPluginState();
});

afterEach(() => {
  clearMemoryPluginState();
  home.restore();
});

describe("OpenClaw memory slot", () => {
  it("OpenClaw treats Kemory as a native memory provider once the plugin registers", async () => {
    const resolveKind = await loadProviderKindResolver();
    const fakeApi = createFakeApi({ apiKey: "host-test-key-123456" });
    expect(resolveKind(CONFIG)).toBeUndefined();

    plugin.register(fakeApi.api);
    expect(fakeApi.memoryCapabilities).toHaveLength(1);
    registerMemoryCapability("kemory", fakeApi.memoryCapabilities[0] as Capability);

    expect(resolveKind(CONFIG)).toBe("native");
  });

  it("a capability without providerRuntime is not native (control)", async () => {
    const resolveKind = await loadProviderKindResolver();

    registerMemoryCapability("kemory", { promptBuilder: () => [] });

    expect(resolveKind(CONFIG)).toBeUndefined();
  });
});
