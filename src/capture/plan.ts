import { createHash } from "node:crypto";
import { redact } from "./redact.js";

export interface CaptureState {
  digest: string;
  captured_turns: number;
  recent: string[];
}

export type CaptureWhen = "mid-session" | "before compaction" | "at session end";

export interface CapturePlanInput {
  prompts: string[];
  state: CaptureState | null;
  kind: "incremental" | "flush";
  when: CaptureWhen;
  channel: string;
  minNewTurns?: number;
  maxTurns?: number;
  maxChars?: number;
}

export interface CapturePlan {
  content: string;
  turns: number;
  next: CaptureState;
}

const DEFAULT_MIN_NEW_TURNS = 3;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_CHARS = 8000;
const RECENT_LIMIT = 50;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A short stable id for a prompt, so the mark never stores prompt text. */
export function fingerprint(prompt: string): string {
  return sha256(prompt).slice(0, 16);
}

/**
 * Index of the first prompt not yet stored. The stored position is trusted while the
 * prompt there still matches; when compaction has rewritten the history, the newest
 * stored prompt is searched for instead. A repeated short prompt ("yes") is told apart
 * by also matching the stored prompt before it.
 */
export function newPromptStart(prompts: string[], state: CaptureState | null): number {
  if (!state || state.recent.length === 0) return 0;
  const last = state.recent[state.recent.length - 1];
  const before = state.recent.length >= 2 ? state.recent[state.recent.length - 2] : undefined;

  const at = state.captured_turns;
  if (at > 0 && at <= prompts.length && fingerprint(prompts[at - 1] ?? "") === last) return at;

  for (let i = prompts.length - 1; i >= 0; i--) {
    if (fingerprint(prompts[i] ?? "") !== last) continue;
    if (i === 0 || before === undefined || fingerprint(prompts[i - 1] ?? "") === before) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Decides what to send. Mirrors kemory-cli internal/hook/capture.go (min 3 new prompts
 * mid-session, newest 12, redact the whole body then cut it, digest over the content),
 * with an OpenClaw header and the recent fingerprints that survive compaction.
 */
export function planCapture(input: CapturePlanInput): CapturePlan | null {
  const { prompts, state, kind, when, channel } = input;
  const minNewTurns = input.minNewTurns ?? DEFAULT_MIN_NEW_TURNS;
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

  const start = newPromptStart(prompts, state);
  const fresh = prompts.slice(start);
  if (fresh.length === 0) return null;
  if (kind === "incremental" && fresh.length < minNewTurns) return null;

  const posted = maxTurns > 0 ? fresh.slice(-maxTurns) : fresh;
  const first = start + fresh.length - posted.length + 1;
  const last = start + fresh.length;

  // Redact first so a secret that straddles the cut is never half kept, then cut by
  // code points so a surrogate pair is never split.
  const body = Array.from(redact(posted.map((p) => `- ${p}`).join("\n")))
    .slice(0, maxChars)
    .join("");
  const content =
    `What was this OpenClaw session about? Session digest captured automatically ` +
    `(${when}, user turns only, secrets redacted, turns ${first}-${last}).\n\n` +
    `channel: ${channel}\n\n${body}`;

  const digest = sha256(content);
  if (state && digest === state.digest) return null;

  return {
    content,
    turns: posted.length,
    next: {
      digest,
      captured_turns: prompts.length,
      recent: [...(state?.recent ?? []), ...fresh.map(fingerprint)].slice(-RECENT_LIMIT),
    },
  };
}
