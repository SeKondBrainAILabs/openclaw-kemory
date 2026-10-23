import { describe, expect, it } from "vitest";
import { isIncognitoSessionKey, memoryAllowed } from "../src/audience.js";

describe("memoryAllowed", () => {
  it("allows only owner-private, user or absent trigger, non-incognito, external_user or absent provenance", () => {
    const owner = { memoryAudience: { kind: "owner-private" } };

    expect(memoryAllowed(owner)).toBe(true);
    expect(memoryAllowed({ ...owner, trigger: "user" })).toBe(true);
    expect(memoryAllowed({ ...owner, inputProvenance: { kind: "external_user" } })).toBe(true);
    expect(memoryAllowed({ ...owner, sessionKey: "agent:main:telegram:direct:42" })).toBe(true);

    expect(memoryAllowed(undefined)).toBe(false);
    expect(memoryAllowed({})).toBe(false);
    expect(memoryAllowed({ memoryAudience: { kind: "conversation" } })).toBe(false);
    expect(memoryAllowed({ ...owner, trigger: "cron" })).toBe(false);
    expect(memoryAllowed({ ...owner, trigger: "heartbeat" })).toBe(false);
    expect(memoryAllowed({ ...owner, trigger: "webhook" })).toBe(false);
    expect(memoryAllowed({ ...owner, inputProvenance: { kind: "webhook" } })).toBe(false);
    expect(memoryAllowed({ ...owner, inputProvenance: { kind: "inter_session" } })).toBe(false);
    expect(memoryAllowed({ ...owner, sessionKey: "agent:main:dashboard:incognito-abc" })).toBe(
      false,
    );
  });
});

describe("isIncognitoSessionKey", () => {
  it("matches incognito dashboard, subagent and internal session keys only", () => {
    expect(isIncognitoSessionKey("agent:main:dashboard:incognito-1")).toBe(true);
    expect(isIncognitoSessionKey("agent:a:subagent:incognito-x")).toBe(true);
    expect(isIncognitoSessionKey("agent:a:internal-session-effects:incognito-x")).toBe(true);
    expect(isIncognitoSessionKey("agent:main:dashboard:abc")).toBe(false);
    expect(isIncognitoSessionKey("agent:main:telegram:incognito-1")).toBe(false);
    expect(isIncognitoSessionKey("agent:main:dashboard:incognito-1:extra")).toBe(false);
    expect(isIncognitoSessionKey(undefined)).toBe(false);
  });
});
