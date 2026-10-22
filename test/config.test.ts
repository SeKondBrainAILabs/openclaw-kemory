import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("returns the documented defaults for an empty config", () => {
    expect(parseConfig({}, {})).toEqual({
      apiKey: undefined,
      apiKeyRef: false,
      env: "prod",
      baseUrl: undefined,
      autoRecall: true,
      autoCapture: true,
      captureNamespace: "user:sessions",
      captureVisibility: "user-private",
      contextMaxChars: 4000,
      contextNamespaces: [],
      recallTimeoutMs: 2000,
      requestTimeoutMs: 10000,
      debug: false,
    });
  });

  it("KEMORY_CONTEXT=0 turns recall off and KEMORY_AUTO_CAPTURE=0 turns capture off", () => {
    const raw = { autoRecall: true, autoCapture: true };
    expect(parseConfig(raw, { KEMORY_CONTEXT: "0" })).toMatchObject({
      autoRecall: false,
      autoCapture: true,
    });
    expect(parseConfig(raw, { KEMORY_AUTO_CAPTURE: "0" })).toMatchObject({
      autoRecall: true,
      autoCapture: false,
    });
    expect(parseConfig(raw, { KEMORY_CONTEXT: "1", KEMORY_AUTO_CAPTURE: "1" })).toMatchObject({
      autoRecall: true,
      autoCapture: true,
    });
  });

  it("config env beats KEMORY_ENV, which beats prod", () => {
    expect(parseConfig({ env: "India" }, { KEMORY_ENV: "staging" }).env).toBe("india");
    expect(parseConfig({}, { KEMORY_ENV: "Staging" }).env).toBe("staging");
    expect(parseConfig({}, {}).env).toBe("prod");
  });

  it("floors contextMaxChars at 500 and trims a trailing slash from baseUrl", () => {
    expect(parseConfig({ contextMaxChars: 100 }, {}).contextMaxChars).toBe(500);
    expect(parseConfig({ contextMaxChars: 9000 }, {}).contextMaxChars).toBe(9000);
    expect(parseConfig({ baseUrl: "http://127.0.0.1:9/" }, {}).baseUrl).toBe("http://127.0.0.1:9");
  });

  it("a SecretRef object apiKey sets apiKeyRef and leaves apiKey undefined", () => {
    const config = parseConfig({ apiKey: { source: "env", provider: "default", id: "KEY" } }, {});
    expect(config.apiKeyRef).toBe(true);
    expect(config.apiKey).toBeUndefined();
  });

  it("trims a string apiKey and falls back to defaults for values of the wrong type", () => {
    const config = parseConfig(
      { apiKey: "  k-123  ", autoRecall: "yes", recallTimeoutMs: "fast", contextNamespaces: "a" },
      {},
    );
    expect(config.apiKey).toBe("k-123");
    expect(config.apiKeyRef).toBe(false);
    expect(config.autoRecall).toBe(true);
    expect(config.recallTimeoutMs).toBe(2000);
    expect(config.contextNamespaces).toEqual([]);
    expect(parseConfig({ apiKey: "   " }, {}).apiKey).toBeUndefined();
    expect(parseConfig("nonsense", {})).toMatchObject({ env: "prod" });
  });
});
