import { describe, expect, it } from "vitest";
import { redact } from "../../src/capture/redact.js";

describe("redact", () => {
  it("keeps prose and removes credentials", () => {
    const cases: [string, string][] = [
      ["we need a token for this", "we need a token for this"],
      ["set api_key=abcdef123456 here", "set [REDACTED] here"],
      ["Bearer abcdefghijkl", "[REDACTED]"],
      ["key sk-abcdefghijklmnopqrstu", "key [REDACTED]"],
      ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "[REDACTED]"],
      ["AKIAABCDEFGHIJKLMNOP", "[REDACTED]"],
      ["password: hunter2hunter2", "[REDACTED]"],
      ["eyJabcdefghijk.eyJabcdefghijk.sigabcdefghij", "[REDACTED]"],
    ];
    for (const [input, want] of cases) {
      expect(redact(input), input).toBe(want);
    }
  });

  it("replaces every match, ignoring case, and answers the same on repeated calls", () => {
    const input = "TOKEN=abcdef123456 and PASSWORD: hunter2hunter2";
    expect(redact(input)).toBe("[REDACTED] and [REDACTED]");
    expect(redact(input)).toBe("[REDACTED] and [REDACTED]");
  });

  it("replaces the private key header line the pattern matches", () => {
    expect(redact("a -----BEGIN RSA PRIVATE KEY----- b")).toBe("a [REDACTED] b");
  });
});
