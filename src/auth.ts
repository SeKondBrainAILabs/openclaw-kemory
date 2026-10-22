import type { KemoryConfig } from "./config.js";
import type { PluginLog } from "./log.js";

export const NOT_SIGNED_IN =
  'kemory: not signed in. Run "kemory login" on this host, or set plugins.entries.kemory.config.apiKey. Memory is off.';
export const SECRET_REF_UNAVAILABLE =
  "kemory: plugins.entries.kemory.config.apiKey is a secret reference OpenClaw has not prepared for this call; ignoring it.";
export const DEFAULT_BASE_URL = "https://api.kemory.s9n.ai";

export type AuthSource = "cli-login" | "cli-api-key" | "config-api-key";

export interface Auth {
  source: AuthSource;
  env: string;
  baseUrl: string;
  headers: Record<string, string>;
  orgId?: string;
}

export interface AuthProvider {
  resolve(signal: AbortSignal): Promise<Auth | null>;
  refreshAfter401(failed: Auth, signal: AbortSignal): Promise<Auth | null>;
}

/**
 * Where the credential comes from. Resolved on every call, never cached: an
 * OpenClaw secret reference is readable only inside a plugin invocation.
 */
export function createAuthProvider(
  config: KemoryConfig,
  opts: {
    log: PluginLog;
    home: string;
    fetch?: typeof fetch;
    readSecretApiKey?: () => string | undefined;
  },
): AuthProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  function configApiKey(): string | undefined {
    if (!config.apiKeyRef) return config.apiKey;
    let value: unknown;
    try {
      value = opts.readSecretApiKey?.();
    } catch {
      value = undefined;
    }
    const key = typeof value === "string" ? value.trim() : "";
    if (key === "") {
      opts.log.once("secret-ref", SECRET_REF_UNAVAILABLE);
      return undefined;
    }
    return key;
  }

  return {
    async resolve() {
      const key = configApiKey();
      if (key === undefined) return null;
      return {
        source: "config-api-key",
        env: config.env,
        baseUrl,
        headers: { "X-API-Key": key },
      };
    },
    async refreshAfter401() {
      return null;
    },
  };
}
