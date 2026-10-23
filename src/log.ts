import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export interface PluginLog {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  failure(kind: string, err: unknown): void;
  once(key: string, msg: string): void;
}

const FAILURE_WINDOW_MS = 10 * 60_000;

/**
 * Wraps OpenClaw's logger. `failure` warns once per kind per 10 minutes so a
 * down Kemory cannot flood the gateway log; repeats go to debug.
 */
export function createLog(
  logger: PluginLogger,
  opts: { debug: boolean; now?: () => number },
): PluginLog {
  const now = opts.now ?? Date.now;
  const lastWarned = new Map<string, number>();
  const seen = new Set<string>();

  const debug = (msg: string): void => {
    if (!opts.debug) return;
    if (logger.debug) logger.debug(msg);
    else logger.info(msg);
  };

  return {
    debug,
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
    failure(kind, err) {
      const detail = err instanceof Error ? err.message : String(err);
      const msg = `kemory: ${kind} failed: ${detail}`;
      const at = now();
      const previous = lastWarned.get(kind);
      if (previous === undefined || at - previous >= FAILURE_WINDOW_MS) {
        lastWarned.set(kind, at);
        logger.warn(msg);
      } else {
        debug(msg);
      }
    },
    once(key, msg) {
      if (seen.has(key)) return;
      seen.add(key);
      logger.info(msg);
    },
  };
}
