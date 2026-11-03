import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaptureState } from "./plan.js";

/** Where the high-water mark for one agent session lives. */
export function statePath(home: string, agentId: string, sessionKey: string): string {
  const id = createHash("sha256").update(`${agentId}:${sessionKey}`).digest("hex").slice(0, 32);
  return join(home, ".kemory", ".captured", `openclaw-${id}`);
}

function isCaptureState(value: unknown): value is CaptureState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.digest === "string" &&
    typeof v.captured_turns === "number" &&
    Number.isInteger(v.captured_turns) &&
    v.captured_turns >= 0 &&
    Array.isArray(v.recent) &&
    v.recent.every((entry) => typeof entry === "string")
  );
}

/** Reads a mark; a missing, unreadable or malformed file counts as no mark. */
export async function readState(path: string): Promise<CaptureState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isCaptureState(parsed)) return null;
  return { digest: parsed.digest, captured_turns: parsed.captured_turns, recent: parsed.recent };
}

/** Writes a mark atomically: a 0600 temp file in the same directory, renamed into place. */
export async function writeState(path: string, state: CaptureState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
