import type { Auth, AuthProvider } from "./auth.js";

export type KemoryErrorKind =
  | "not_signed_in"
  | "timeout"
  | "http"
  | "redirect"
  | "network"
  | "bad_response";

/** Messages carry the kind, method, path and status only, never a header value. */
export class KemoryError extends Error {
  readonly kind: KemoryErrorKind;
  readonly status?: number;
  readonly body?: unknown;

  constructor(
    kind: KemoryErrorKind,
    method: string,
    path: string,
    extra: { status?: number; body?: unknown } = {},
  ) {
    const status = extra.status === undefined ? "" : ` -> ${extra.status}`;
    super(`kemory ${kind}: ${method} ${path}${status}`);
    this.name = "KemoryError";
    this.kind = kind;
    this.status = extra.status;
    this.body = extra.body;
  }
}

export interface KemoryClient {
  request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: unknown; timeoutMs: number },
  ): Promise<{ status: number; body: T | undefined }>;
}

type Method = "GET" | "POST" | "DELETE";

/**
 * Every Kemory call goes through here, so the credential, the organisation
 * header and the deadline apply to every caller alike.
 */
export function createKemoryClient(
  auth: AuthProvider,
  opts: { version: string; fetch?: typeof fetch },
): KemoryClient {
  const doFetch = opts.fetch ?? fetch;

  async function send<T>(
    method: Method,
    path: string,
    body: string | undefined,
    current: Auth,
    signal: AbortSignal,
  ): Promise<{ status: number; body: T | undefined }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `openclaw-kemory/${opts.version}`,
      ...current.headers,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${current.baseUrl.replace(/\/+$/u, "")}${path}`, {
        method,
        headers,
        body,
        redirect: "manual",
        signal,
      });
      text = await res.text();
    } catch (err) {
      if (err instanceof KemoryError) throw err;
      throw new KemoryError(signal.aborted ? "timeout" : "network", method, path);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new KemoryError("redirect", method, path, { status: res.status });
    }

    let parsed: unknown;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (res.ok) throw new KemoryError("bad_response", method, path, { status: res.status });
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new KemoryError("http", method, path, { status: res.status, body: parsed });
    }
    return { status: res.status, body: parsed as T | undefined };
  }

  async function run<T>(
    method: Method,
    path: string,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<{ status: number; body: T | undefined }> {
    const first = await auth.resolve(signal);
    if (!first) throw new KemoryError("not_signed_in", method, path);
    try {
      return await send<T>(method, path, body, first, signal);
    } catch (err) {
      if (!(err instanceof KemoryError) || err.status !== 401) throw err;
      const second = await auth.refreshAfter401(first, signal);
      if (!second) throw err;
      return await send<T>(method, path, body, second, signal);
    }
  }

  return {
    async request<T>(method: Method, path: string, reqOpts: { body?: unknown; timeoutMs: number }) {
      const signal = AbortSignal.timeout(reqOpts.timeoutMs);
      const body = reqOpts.body === undefined ? undefined : JSON.stringify(reqOpts.body);

      // The deadline is raced explicitly because auth.resolve and refreshAfter401
      // are not obliged to honour the signal.
      let onAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new KemoryError("timeout", method, path));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([run<T>(method, path, body, signal), deadline]);
      } catch (err) {
        if (err instanceof KemoryError) throw err;
        throw new KemoryError(signal.aborted ? "timeout" : "network", method, path);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
