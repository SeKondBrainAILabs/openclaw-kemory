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

  it("redacts a credential under a JSON-, dict- or escaped-JSON-quoted key", () => {
    const cases: [string, string][] = [
      ['my config is {"api_key": "abcdef123456"}', 'my config is {"[REDACTED]"}'],
      ['{"api_key": "abcdef123456"}', '{"[REDACTED]"}'],
      ['{"api_key" : "abcdef123456"}', '{"[REDACTED]"}'],
      ['"password": "hunter2hunter2"', '"[REDACTED]"'],
      ["{'api_key': 'abcdef123456'}", "{'[REDACTED]'}"],
      ['{"apiKey":"abcdef123456","name":"x"}', '{"[REDACTED]","name":"x"}'],
      ['{"client_secret": "abcdef123456"}', '{"client_[REDACTED]"}'],
      // The text {\"api_key\": \"abcdef123456\"}: each quote is preceded by one backslash.
      ['{\\"api_key\\": \\"abcdef123456\\"}', '{\\"[REDACTED]"}'],
    ];
    for (const [input, want] of cases) {
      expect(redact(input), input).toBe(want);
    }
  });

  it("redacts a Bearer token under a quoted key, as it does under an unquoted one", () => {
    const cases: [string, string][] = [
      ['{"token": "Bearer abcdefgh12345678"}', '{"[REDACTED]"}'],
      ['{"access_token": "Bearer abcdefgh12345678"}', '{"[REDACTED]"}'],
      ["{'auth_token': 'Bearer abcdefgh12345678'}", "{'[REDACTED]'}"],
      ['{\\"token\\": \\"Bearer abcdefgh12345678\\"}', '{\\"[REDACTED]"}'],
      ["token: Bearer abcdefgh12345678", "[REDACTED]"],
    ];
    for (const [input, want] of cases) {
      const out = redact(input);
      expect(out, input).toBe(want);
      expect(out, input).not.toContain("abcdefgh12345678");
    }
  });

  it("redacts every keyword under every key quoting and separator (table built from the keyword list)", () => {
    const keywords = [
      "api_key",
      "api-key",
      "apikey",
      "api_token",
      "api-token",
      "apitoken",
      "access_token",
      "access-token",
      "accesstoken",
      "auth_token",
      "auth-token",
      "authtoken",
      "token",
      "secret",
      "password",
      "passwd",
      "pwd",
    ];
    const quotes = ["", '"', "'", '\\"'];
    const separators = [":", "=", ": ", " = ", " : "];
    const value = "abcdef123456";
    let count = 0;
    for (const keyword of keywords) {
      for (const quote of quotes) {
        for (const separator of separators) {
          const input = `${quote}${keyword}${quote}${separator}${quote}${value}${quote}`;
          expect(redact(input), input).not.toContain(value);
          count += 1;
        }
      }
    }
    expect(count).toBe(340);
  });

  it("keeps a quoted key whose value is shorter than 6 characters, and quoted prose", () => {
    for (const input of [
      '{"token": "abc"}',
      'the "token": it is important here',
      "we need a token for this",
    ]) {
      expect(redact(input), input).toBe(input);
    }
  });
});

describe("redact credential shapes", () => {
  const keywords = [
    "api_key",
    "api-key",
    "apikey",
    "api_token",
    "api-token",
    "apitoken",
    "access_token",
    "access-token",
    "accesstoken",
    "auth_token",
    "auth-token",
    "authtoken",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
  ];

  it.each(keywords)("redacts a value assigned to %s", (keyword) => {
    expect(redact(`${keyword}=abcdef123456`)).toBe("[REDACTED]");
    expect(redact(`${keyword}: abcdef123456`)).toBe("[REDACTED]");
  });

  it("redacts a quoted keyword value, quote included on the opening side", () => {
    expect(redact(`secret="abcdef123456"`)).toBe(`[REDACTED]"`);
    expect(redact(`secret='abcdef123456'`)).toBe(`[REDACTED]'`);
  });

  it("keeps a keyword value shorter than six characters", () => {
    expect(redact("secret=abcde")).toBe("secret=abcde");
    expect(redact("secret=abcdef")).toBe("[REDACTED]");
  });

  it("stops a keyword value at whitespace, quotes, commas, semicolons and braces", () => {
    for (const end of [" x", '"x', "'x", ",x", ";x", "}x"]) {
      expect(redact(`pwd=abcdef123456${end}`)).toBe(`[REDACTED]${end}`);
    }
  });

  it("redacts bearer values of eight or more characters and keeps shorter ones", () => {
    expect(redact("Authorization: Bearer abc.def-123_x")).toBe("Authorization: [REDACTED]");
    expect(redact("bearer abcdefgh")).toBe("[REDACTED]");
    expect(redact("bearer abcdefg")).toBe("bearer abcdefg");
  });

  it("redacts sk- keys of sixteen or more characters and keeps shorter ones", () => {
    expect(redact("sk-abcdefghijklmnop")).toBe("[REDACTED]");
    expect(redact("sk-abcdefghijklmno")).toBe("sk-abcdefghijklmno");
  });

  it.each(["p", "o", "u", "s", "r"])("redacts a gh%s_ GitHub token", (kind) => {
    expect(redact(`gh${kind}_${"A".repeat(20)}`)).toBe("[REDACTED]");
  });

  it("keeps a GitHub token with fewer than twenty characters after the prefix", () => {
    expect(redact(`ghp_${"A".repeat(19)}`)).toBe(`ghp_${"A".repeat(19)}`);
    expect(redact(`gho_${"A".repeat(19)}`)).toBe(`gho_${"A".repeat(19)}`);
  });

  it("keeps an AKIA key id that is not sixteen characters after the prefix", () => {
    expect(redact(`AKIA${"A".repeat(16)}`)).toBe("[REDACTED]");
    expect(redact(`AKIA${"A".repeat(15)}`)).toBe(`AKIA${"A".repeat(15)}`);
  });

  it.each(["b", "a", "p", "r", "s"])("redacts an xox%s- Slack token", (kind) => {
    expect(redact(`xox${kind}-1234567890`)).toBe("[REDACTED]");
  });

  it("redacts a Slack token with hyphenated segments and keeps one under ten characters", () => {
    expect(redact("xoxb-123456789-abcdef")).toBe("[REDACTED]");
    expect(redact("xoxb-123456789")).toBe("xoxb-123456789");
  });

  it("keeps a JWT-like string whose segment is under ten characters", () => {
    for (const jwt of [
      "eyJabcdefghi.abcdefghij.abcdefghij",
      "eyJabcdefghij.abcdefghi.abcdefghij",
      "eyJabcdefghij.abcdefghij.abcdefghi",
    ]) {
      expect(redact(jwt)).toBe(jwt);
    }
  });

  it("redacts a private key header without the RSA qualifier", () => {
    expect(redact("-----BEGIN PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("[REDACTED]");
  });
});
