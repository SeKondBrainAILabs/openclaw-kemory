import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureState } from "../../src/capture/plan.js";
import { readState, statePath, writeState } from "../../src/capture/state.js";
import { useTempHome } from "../helpers/temp-home.js";

const STATE: CaptureState = { digest: "abc", captured_turns: 3, recent: ["f1", "f2", "f3"] };

let tmp: ReturnType<typeof useTempHome>;

beforeEach(() => {
  tmp = useTempHome();
});

afterEach(() => {
  tmp.restore();
});

describe("capture state", () => {
  it("path is openclaw-<32 hex> under .kemory/.captured with 0700 dir and 0600 file", async () => {
    const path = statePath(tmp.home, "main", "agent:main:telegram:123");
    const hex = createHash("sha256").update("main:agent:main:telegram:123").digest("hex");
    expect(path).toBe(join(tmp.home, ".kemory", ".captured", `openclaw-${hex.slice(0, 32)}`));
    expect(path).toMatch(/\/\.kemory\/\.captured\/openclaw-[0-9a-f]{32}$/);

    await writeState(path, STATE);

    expect(statSync(join(tmp.home, ".kemory", ".captured")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readState(path)).toEqual(STATE);
    // The temp file is renamed into place, so nothing else is left behind.
    expect(readdirSync(join(tmp.home, ".kemory", ".captured"))).toEqual([
      `openclaw-${hex.slice(0, 32)}`,
    ]);
  });

  it("gives each agent and session its own file", () => {
    const a = statePath(tmp.home, "main", "s1");
    expect(statePath(tmp.home, "main", "s2")).not.toBe(a);
    expect(statePath(tmp.home, "other", "s1")).not.toBe(a);
    // The ":" separator keeps ("ab", "c") apart from ("a", "bc").
    expect(statePath(tmp.home, "ab", "c")).not.toBe(statePath(tmp.home, "a", "bc"));
  });

  it("overwrites an earlier state", async () => {
    const path = statePath(tmp.home, "main", "s1");
    await writeState(path, STATE);
    const next = { digest: "def", captured_turns: 5, recent: ["f5"] };
    await writeState(path, next);
    expect(await readState(path)).toEqual(next);
  });

  it("rejects and leaves no temp file when the rename fails", async () => {
    const path = statePath(tmp.home, "main", "s1");
    // A directory at the target makes the rename fail after the temp file was written.
    mkdirSync(path, { recursive: true });

    await expect(writeState(path, STATE)).rejects.toThrow();

    expect(readdirSync(join(tmp.home, ".kemory", ".captured"))).toEqual([basename(path)]);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it("rejects and leaves no temp file when the temp file cannot be written", async () => {
    const path = statePath(tmp.home, "main", "s1");
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      await expect(writeState(path, STATE)).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }

    expect(readdirSync(dir)).toEqual([]);
  });

  it("invalid or missing state reads as null", async () => {
    const dir = join(tmp.home, ".kemory", ".captured");
    mkdirSync(dir, { recursive: true });
    const read = async (content: string) => {
      const path = join(dir, "case");
      writeFileSync(path, content);
      return readState(path);
    };

    expect(await readState(join(dir, "missing"))).toBeNull();
    expect(await read("")).toBeNull();
    expect(await read("not json")).toBeNull();
    expect(await read("[]")).toBeNull();
    expect(await read("null")).toBeNull();
    expect(await read('{"captured_turns":1,"recent":[]}')).toBeNull();
    expect(await read('{"digest":1,"captured_turns":1,"recent":[]}')).toBeNull();
    expect(await read('{"digest":"d","recent":[]}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":"1","recent":[]}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":-1,"recent":[]}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":1.5,"recent":[]}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":1}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":1,"recent":"x"}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":1,"recent":["a",2]}')).toBeNull();
    expect(await read('{"digest":"d","captured_turns":1,"recent":["a"]}')).toEqual({
      digest: "d",
      captured_turns: 1,
      recent: ["a"],
    });
  });
});
