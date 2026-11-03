import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CapturePlan,
  type CaptureState,
  fingerprint,
  newPromptStart,
  planCapture,
} from "../../src/capture/plan.js";

function header(when: string, first: number, last: number): string {
  return `What was this OpenClaw session about? Session digest captured automatically (${when}, user turns only, secrets redacted, turns ${first}-${last}).`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Plans an incremental capture that is expected to produce a plan. */
function mustPlan(prompts: string[], state: CaptureState | null, extra = {}): CapturePlan {
  const plan = planCapture({
    prompts,
    state,
    kind: "incremental",
    when: "mid-session",
    channel: "test",
    ...extra,
  });
  if (!plan) throw new Error("expected a plan");
  return plan;
}

describe("planCapture", () => {
  it("stores new turns once (port of kemory-cli TestPlanStoresNewTurnsOnce)", () => {
    const base = { kind: "incremental", when: "mid-session", channel: "test" } as const;

    expect(planCapture({ ...base, prompts: ["a", "b"], state: null })).toBeNull();

    const first = planCapture({ ...base, prompts: ["a", "b", "c"], state: null });
    expect(first?.content).toBe(`${header("mid-session", 1, 3)}\n\nchannel: test\n\n- a\n- b\n- c`);
    expect(first?.turns).toBe(3);
    expect(first?.next.captured_turns).toBe(3);
    expect(first?.next.digest).toBe(sha256(first?.content ?? ""));

    // The same input with the stored state sends nothing.
    expect(
      planCapture({ ...base, prompts: ["a", "b", "c"], state: first?.next ?? null }),
    ).toBeNull();

    const flush = planCapture({
      prompts: ["a", "b", "c", "d"],
      state: first?.next ?? null,
      kind: "flush",
      when: "at session end",
      channel: "test",
    });
    expect(flush?.content).toBe(`${header("at session end", 4, 4)}\n\nchannel: test\n\n- d`);
    expect(flush?.turns).toBe(1);

    const capped = planCapture({
      ...base,
      prompts: ["a", "b", "c", "d", "e", "f", "g", "h"],
      state: first?.next ?? null,
      maxTurns: 2,
    });
    expect(capped?.content).toBe(`${header("mid-session", 7, 8)}\n\nchannel: test\n\n- g\n- h`);
    expect(capped?.turns).toBe(2);
  });

  it("numbers the turns from the newest posted prompt when maxTurns trims the batch", () => {
    const plan = mustPlan(["p1", "p2", "p3", "p4", "p5"], null, { maxTurns: 2 });
    expect(plan.content).toBe(`${header("mid-session", 4, 5)}\n\nchannel: test\n\n- p4\n- p5`);
    expect(plan.next.captured_turns).toBe(5);
    expect(plan.next.recent).toHaveLength(5);
  });

  it("a maxTurns of 0 or less posts every new prompt", () => {
    expect(mustPlan(["a", "b", "c"], null, { maxTurns: 0 }).turns).toBe(3);
    expect(mustPlan(["a", "b", "c"], null, { maxTurns: -1 }).turns).toBe(3);
  });

  it("a flush stores a single pending prompt", () => {
    const plan = planCapture({
      prompts: ["only one"],
      state: null,
      kind: "flush",
      when: "before compaction",
      channel: "slack",
    });
    expect(plan?.content).toBe(
      `${header("before compaction", 1, 1)}\n\nchannel: slack\n\n- only one`,
    );
    expect(plan?.turns).toBe(1);
    expect(
      planCapture({
        prompts: [],
        state: null,
        kind: "flush",
        when: "at session end",
        channel: "slack",
      }),
    ).toBeNull();
  });

  it("an incremental capture honours minNewTurns", () => {
    expect(mustPlan(["a", "b"], null, { minNewTurns: 2 }).turns).toBe(2);
    expect(
      planCapture({
        prompts: ["a", "b", "c", "d"],
        state: null,
        kind: "incremental",
        when: "mid-session",
        channel: "test",
        minNewTurns: 5,
      }),
    ).toBeNull();
  });

  it("keeps the newest 12 prompts and cuts the body to the first 8000 code points after redaction", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `prompt ${i + 1}`);
    const plan = mustPlan(twenty, null);
    expect(plan.turns).toBe(12);
    expect(plan.content).toContain("turns 9-20).");
    expect(
      plan.content.endsWith(
        "- prompt 9\n- prompt 10\n- prompt 11\n- prompt 12\n- prompt 13\n- prompt 14\n- prompt 15\n- prompt 16\n- prompt 17\n- prompt 18\n- prompt 19\n- prompt 20",
      ),
    ).toBe(true);
    expect(plan.content).not.toContain("- prompt 8\n");
    expect(plan.next.captured_turns).toBe(20);
    // The mark covers every new prompt, not only the ones posted.
    expect(plan.next.recent).toEqual(twenty.map(fingerprint));

    const long = ["x".repeat(5000), "y".repeat(5000), "z"];
    const cut = mustPlan(long, null);
    const body = cut.content.split("\n\n").slice(2).join("\n\n");
    expect(Array.from(body)).toHaveLength(8000);
    expect(body.startsWith(`- ${"x".repeat(5000)}\n- yyy`)).toBe(true);

    // A cut never splits a surrogate pair: 4001 emoji are 8002 UTF-16 units.
    const emoji = mustPlan(["😀".repeat(4001), "b", "c"], null, { maxChars: 4000 });
    const emojiBody = emoji.content.split("\n\n").slice(2).join("\n\n");
    expect(Array.from(emojiBody)).toHaveLength(4000);
    expect(emojiBody.endsWith("😀")).toBe(true);
    expect(emojiBody.includes("\ud83d\n")).toBe(false);
  });

  it("redacts the whole body before it cuts, so a secret on the cut is not half kept", () => {
    const secret = "sk-abcdefghijklmnopqrstu";
    const plan = mustPlan(["a", "b", `key ${secret}`], null, { maxChars: 10 });
    const body = plan.content.split("\n\n").slice(2).join("\n\n");
    expect(body).toBe("- a\n- b\n- ");
    expect(plan.content).not.toContain("sk-");
    // A cut inside the secret keeps part of the placeholder, never the start of the secret.
    const straddle = mustPlan(["a", "b", `key ${secret}`], null, { maxChars: 20 });
    expect(straddle.content.split("\n\n").slice(2).join("\n\n")).toBe("- a\n- b\n- key [REDAC");
    const kept = mustPlan(["a", "b", `key ${secret}`], null);
    expect(kept.content.endsWith("- key [REDACTED]")).toBe(true);
  });

  it("returns null when the content digest equals the stored one", () => {
    const first = mustPlan(["a", "b", "c"], null);
    // History was rewritten, so the position lookup fails and every prompt is new again.
    const sameContent = planCapture({
      prompts: ["a", "b", "c"],
      state: { digest: first.next.digest, captured_turns: 0, recent: ["unrelated"] },
      kind: "incremental",
      when: "mid-session",
      channel: "test",
    });
    expect(sameContent).toBeNull();
  });

  it("keeps at most the 50 newest fingerprints", () => {
    const first = mustPlan(
      Array.from({ length: 40 }, (_, i) => `p${i}`),
      null,
    );
    const prompts = Array.from({ length: 70 }, (_, i) => `p${i}`);
    const second = mustPlan(prompts, first.next);
    expect(second.next.recent).toEqual(prompts.slice(-50).map(fingerprint));
    expect(second.next.captured_turns).toBe(70);
  });

  it("after compaction shrinks history, only prompts after the last stored one are new", () => {
    const stored = mustPlan(["a", "b", "c"], null);
    const plan = mustPlan(["c", "d", "e", "f"], stored.next);
    expect(plan.content).toBe(`${header("mid-session", 2, 4)}\n\nchannel: test\n\n- d\n- e\n- f`);
    expect(plan.next.captured_turns).toBe(4);
    expect(plan.next.recent).toEqual(["a", "b", "c", "d", "e", "f"].map(fingerprint));
  });

  it("a repeated short prompt does not hide new prompts", () => {
    const stored = mustPlan(["x", "y", "yes"], null);
    const plan = mustPlan(["x", "y", "yes", "d", "yes", "e"], stored.next);
    expect(plan.content).toBe(`${header("mid-session", 4, 6)}\n\nchannel: test\n\n- d\n- yes\n- e`);
    expect(plan.turns).toBe(3);
  });

  it("no stored prompt found means every prompt is new", () => {
    const stored = mustPlan(["a", "b", "c"], null);
    const plan = mustPlan(["p", "q", "r", "s"], stored.next);
    expect(plan.content).toBe(
      `${header("mid-session", 1, 4)}\n\nchannel: test\n\n- p\n- q\n- r\n- s`,
    );
  });
});

describe("fingerprint", () => {
  it("is the first 16 hex characters of the sha256", () => {
    expect(fingerprint("abc")).toBe(sha256("abc").slice(0, 16));
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });
});

describe("newPromptStart", () => {
  const stateFor = (prompts: string[], captured = prompts.length): CaptureState => ({
    digest: "d",
    captured_turns: captured,
    recent: prompts.map(fingerprint),
  });

  it("is 0 with no state or an empty recent list", () => {
    expect(newPromptStart(["a", "b"], null)).toBe(0);
    expect(newPromptStart(["a", "b"], { digest: "d", captured_turns: 2, recent: [] })).toBe(0);
  });

  it("trusts the stored position when the prompt there is the last stored one", () => {
    expect(newPromptStart(["a", "b", "c", "d"], stateFor(["a", "b"]))).toBe(2);
    expect(newPromptStart(["a", "b"], stateFor(["a", "b"]))).toBe(2);
    // The position at the very end is trusted even when the prompt before it differs.
    const state = { digest: "d", captured_turns: 2, recent: ["x", "yes"].map(fingerprint) };
    expect(newPromptStart(["z", "yes"], state)).toBe(2);
  });

  it("searches from the newest prompt back, so an earlier copy of the stored pair is ignored", () => {
    expect(newPromptStart(["a", "b", "c", "a", "b", "d"], stateFor(["a", "b"], 99))).toBe(5);
  });

  it("prefers the stored position over a later copy of the same prompt", () => {
    expect(newPromptStart(["yes", "a", "yes", "b"], stateFor(["yes"]))).toBe(1);
  });

  it("falls back to a search when the stored position does not match", () => {
    // captured_turns is beyond the history: compaction shrank it.
    expect(newPromptStart(["b", "c", "d"], stateFor(["a", "b", "c"], 3))).toBe(2);
    // The position holds a different prompt.
    expect(newPromptStart(["z", "b", "c", "d"], stateFor(["a", "b", "c"], 4))).toBe(3);
    // A zero position is not trusted.
    expect(newPromptStart(["a", "b", "c"], stateFor(["a", "b"], 0))).toBe(2);
  });

  it("uses the second-to-last stored prompt to tell repeats apart", () => {
    const state = stateFor(["k", "yes", "yes"], 99);
    // Only a "yes" that follows another "yes" matches the stored pair.
    expect(newPromptStart(["k", "yes", "yes", "new"], state)).toBe(3);
    expect(newPromptStart(["k", "yes", "other", "yes"], state)).toBe(0);
  });

  it("matches the last prompt alone when only one is stored or it is the first in history", () => {
    expect(newPromptStart(["q", "a", "b"], stateFor(["a"], 99))).toBe(2);
    expect(newPromptStart(["a", "b"], stateFor(["x", "a"], 99))).toBe(1);
  });

  it("is 0 when the last stored prompt is nowhere in the history", () => {
    expect(newPromptStart(["p", "q"], stateFor(["a", "b"], 99))).toBe(0);
  });
});
