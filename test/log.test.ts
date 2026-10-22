import { describe, expect, it } from "vitest";
import { createLog } from "../src/log.js";

function fakeLogger() {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    logger: {
      debug: (msg: string) => lines.push({ level: "debug", msg }),
      info: (msg: string) => lines.push({ level: "info", msg }),
      warn: (msg: string) => lines.push({ level: "warn", msg }),
      error: (msg: string) => lines.push({ level: "error", msg }),
    },
  };
}

describe("createLog", () => {
  it("failure warns once per kind per 10 minutes and logs repeats at debug", () => {
    const { lines, logger } = fakeLogger();
    let now = 1_000_000;
    const log = createLog(logger, { debug: true, now: () => now });

    log.failure("recall", new Error("boom"));
    log.failure("recall", new Error("boom again"));
    log.failure("capture", new Error("other"));
    now += 10 * 60_000 - 1;
    log.failure("recall", new Error("still inside the window"));
    now += 1;
    log.failure("recall", new Error("window over"));

    expect(lines).toEqual([
      { level: "warn", msg: "kemory: recall failed: boom" },
      { level: "debug", msg: "kemory: recall failed: boom again" },
      { level: "warn", msg: "kemory: capture failed: other" },
      { level: "debug", msg: "kemory: recall failed: still inside the window" },
      { level: "warn", msg: "kemory: recall failed: window over" },
    ]);
  });

  it("debug messages are dropped unless debug is on", () => {
    const off = fakeLogger();
    createLog(off.logger, { debug: false }).debug("hidden");
    expect(off.lines).toEqual([]);

    const on = fakeLogger();
    createLog(on.logger, { debug: true }).debug("shown");
    expect(on.lines).toEqual([{ level: "debug", msg: "shown" }]);
  });

  it("debug falls back to info when the logger has no debug method", () => {
    const lines: string[] = [];
    const log = createLog(
      { info: (m: string) => lines.push(`info ${m}`), warn: () => {}, error: () => {} },
      { debug: true },
    );
    log.debug("fallback");
    expect(lines).toEqual(["info fallback"]);
  });

  it("info and warn pass through, and once logs a key a single time at info", () => {
    const { lines, logger } = fakeLogger();
    const log = createLog(logger, { debug: false });
    log.info("i");
    log.warn("w");
    log.once("k", "first");
    log.once("k", "second");
    log.once("other", "third");
    expect(lines).toEqual([
      { level: "info", msg: "i" },
      { level: "warn", msg: "w" },
      { level: "info", msg: "first" },
      { level: "info", msg: "third" },
    ]);
  });

  it("failure formats a non-Error value", () => {
    const { lines, logger } = fakeLogger();
    createLog(logger, { debug: false }).failure("x", "plain text");
    expect(lines).toEqual([{ level: "warn", msg: "kemory: x failed: plain text" }]);
  });
});
