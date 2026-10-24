import type { KemoryConfig } from "./config.js";
import {
  type CliCredentials,
  isApiKeyCredentials,
  readCredentials,
  refreshCredentials,
  writeCredentials,
} from "./credentials.js";
import type { PluginLog } from "./log.js";

export const NOT_SIGNED_IN =
  'kemory: not signed in. Run "kemory login" on this host, or set plugins.entries.kemory.config.apiKey. Memory is off.';
export const SECRET_REF_UNAVAILABLE =
  "kemory: plugins.entries.kemory.config.apiKey is a secret reference OpenClaw has not prepared for this call; ignoring it.";
export const DEFAULT_BASE_URL = "https://api.kemory.s9n.ai";
/** A refresh outlives the caller that started it, so it has a deadline of its own. */
export const REFRESH_TIMEOUT_MS = 10000;
const NO_ACTIVE_ORG =
  'kemory: your kemory login has no active organisation, so requests use your account\'s home organisation. Run "kemory use <org>" to choose one.';
// Refresh a little early so a token does not expire between resolve and the request.
const EXPIRY_MARGIN_SECONDS = 60;

// One refresh per credentials file in this process. The CLI, its MCP bridge and
// its hooks refresh the same file from other processes; this only stops the
// plugin from racing itself, which would burn a rotated refresh token.
const refreshesInFlight = new Map<string, Promise<CliCredentials | null>>();

function nearExpiry(creds: CliCredentials): boolean {
  return Date.now() / 1000 + EXPIRY_MARGIN_SECONDS >= creds.expires_at;
}

/** Waits for a shared promise only until the caller's own deadline. */
function waitUntilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

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
  const configBaseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetch ?? fetch;

  // Only a boolean outlives a call, never the key. OpenClaw resolves a SecretRef
  // into pluginConfig before register, so config.apiKey is then a stale copy.
  let sawPreparedSecret = false;

  function readPreparedSecret(): string | undefined {
    let value: unknown;
    try {
      value = opts.readSecretApiKey?.();
    } catch {
      return undefined;
    }
    const key = typeof value === "string" ? value.trim() : "";
    return key === "" ? undefined : key;
  }

  function configApiKey(): string | undefined {
    const prepared = readPreparedSecret();
    if (prepared !== undefined) {
      sawPreparedSecret = true;
      return prepared;
    }
    if (config.apiKeyRef || sawPreparedSecret) {
      opts.log.once("secret-ref", SECRET_REF_UNAVAILABLE);
      return undefined;
    }
    return config.apiKey;
  }

  function configAuth(): Auth | null {
    const key = configApiKey();
    if (key === undefined) return null;
    return {
      source: "config-api-key",
      env: config.env,
      baseUrl: configBaseUrl,
      headers: { "X-API-Key": key },
    };
  }

  function fileAuth(creds: CliCredentials): Auth | null {
    if (creds.access_token === "") return null;
    const baseUrl =
      config.baseUrl ?? (creds.kemory_url === "" ? DEFAULT_BASE_URL : creds.kemory_url);
    if (isApiKeyCredentials(creds)) {
      // The key's organisation is fixed server-side, so no org header is sent.
      return {
        source: "cli-api-key",
        env: config.env,
        baseUrl,
        headers: { "X-API-Key": creds.access_token },
      };
    }
    const orgId = creds.active_org_id || creds.org_id || undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.access_token}` };
    if (orgId === undefined) opts.log.once("no-active-org", NO_ACTIVE_ORG);
    else headers["X-Organization-ID"] = orgId;
    return { source: "cli-login", env: config.env, baseUrl, headers, orgId };
  }

  /**
   * Brings the login file up to date: re-read first (another process may have
   * refreshed it), then ask the issuer, and write the result back before anyone
   * uses it. `failedToken` is set after a 401, when a near-expiry check alone would
   * keep trusting a token the server just rejected.
   */
  async function refreshFile(
    signal: AbortSignal,
    failedToken: string | undefined,
  ): Promise<CliCredentials | null> {
    const latest = await readCredentials(opts.home, config.env);
    if (!latest) return null;
    const usable = (c: CliCredentials) =>
      !nearExpiry(c) && (failedToken === undefined || c.access_token !== failedToken);
    if (isApiKeyCredentials(latest) || usable(latest)) return latest;

    const refreshed = await refreshCredentials(latest, signal, doFetch);
    if (refreshed) {
      try {
        await writeCredentials(opts.home, config.env, refreshed);
      } catch (err) {
        // This call can still use the new tokens, but the CLI cannot see them.
        opts.log.failure("credentials-write", err);
      }
      return refreshed;
    }

    // Rejected: another process may have rotated the token while ours was in flight.
    const after = await readCredentials(opts.home, config.env);
    if (after && after.refresh_token !== latest.refresh_token && usable(after)) return after;
    return null;
  }

  /** Single-flight per file; the refresh runs on its own deadline, not the caller's. */
  function refresh(signal: AbortSignal, failedToken?: string): Promise<CliCredentials | null> {
    const key = `${opts.home}\0${config.env}`;
    let flight = refreshesInFlight.get(key);
    if (!flight) {
      flight = refreshFile(AbortSignal.timeout(REFRESH_TIMEOUT_MS), failedToken).finally(() => {
        refreshesInFlight.delete(key);
      });
      refreshesInFlight.set(key, flight);
    }
    return waitUntilAborted(flight, signal);
  }

  return {
    async resolve(signal) {
      const creds = await readCredentials(opts.home, config.env);
      if (creds) {
        const current =
          isApiKeyCredentials(creds) || !nearExpiry(creds) ? creds : await refresh(signal);
        const auth = current && fileAuth(current);
        if (auth) return auth;
      }
      return configAuth();
    },
    async refreshAfter401(failed, signal) {
      if (failed.source !== "cli-login") return null;
      const failedToken = failed.headers.Authorization?.replace(/^Bearer /u, "");
      const current = await refresh(signal, failedToken);
      return current && fileAuth(current);
    },
  };
}
