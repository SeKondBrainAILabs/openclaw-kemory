export interface KemoryConfig {
  apiKey?: string;
  apiKeyRef: boolean;
  env: string;
  baseUrl?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureNamespace: string;
  captureVisibility: string;
  contextMaxChars: number;
  contextNamespaces: string[];
  recallTimeoutMs: number;
  requestTimeoutMs: number;
  debug: boolean;
}

const MIN_CONTEXT_CHARS = 500;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** An integer inside [min, max]; anything else (including a non-number) is the default. */
function int(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the plugin's config block. The KEMORY_CONTEXT=0 and KEMORY_AUTO_CAPTURE=0
 * switches are the same ones `kemory hook` honours and override the config.
 */
export function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): KemoryConfig {
  const cfg = isObject(raw) ? raw : {};
  const apiKeyRef = isObject(cfg.apiKey);

  return {
    apiKey: nonEmptyString(cfg.apiKey),
    apiKeyRef,
    env: (nonEmptyString(cfg.env) ?? nonEmptyString(env.KEMORY_ENV) ?? "prod").toLowerCase(),
    baseUrl: nonEmptyString(cfg.baseUrl)?.replace(/\/+$/u, ""),
    autoRecall: env.KEMORY_CONTEXT === "0" ? false : bool(cfg.autoRecall, true),
    autoCapture: env.KEMORY_AUTO_CAPTURE === "0" ? false : bool(cfg.autoCapture, true),
    captureNamespace: nonEmptyString(cfg.captureNamespace) ?? "user:sessions",
    captureVisibility: nonEmptyString(cfg.captureVisibility) ?? "user-private",
    contextMaxChars: int(cfg.contextMaxChars, 4000, MIN_CONTEXT_CHARS),
    contextNamespaces: stringList(cfg.contextNamespaces),
    recallTimeoutMs: int(cfg.recallTimeoutMs, 2000, 100, 15000),
    requestTimeoutMs: int(cfg.requestTimeoutMs, 10000, 1000, 60000),
    debug: bool(cfg.debug, false),
  };
}
