import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * The login file `kemory login` writes, shared with kemory-cli. Keys this plugin
 * does not know are kept on write-back, so the CLI never loses a field.
 */
export interface CliCredentials {
  version: number;
  access_token: string;
  refresh_token: string;
  /** Epoch seconds as a float, not milliseconds. */
  expires_at: number;
  issuer: string;
  client_id: string;
  kemory_url: string;
  env?: string;
  email?: string;
  org_id?: string;
  active_org_id?: string;
  [key: string]: unknown;
}

const VERSION = 2;
const REQUIRED_STRINGS = [
  "access_token",
  "refresh_token",
  "issuer",
  "client_id",
  "kemory_url",
] as const;

// Old hosts are rewritten when read, as kemory-cli internal/config/env.go does.
const KEMORY_URL_REWRITES: Record<string, string> = {
  "https://api.kemory.sekondbrain.ai": "https://api.kemory.s9n.ai",
  "https://kemory.prod.apps.s9n.ai": "https://api.kemory.s9n.ai",
};
const ISSUER_REWRITES: Record<string, string> = {
  "https://accounts.prod.apps.s9n.ai/realms/s9n": "https://accounts.sekondbrain.ai/realms/s9n",
};

// The env names the CLI uses are plain words; refusing anything else keeps a
// stray separator in the config from pointing at another path.
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function credentialsDir(home: string): string {
  return join(home, ".kemory");
}

export function credentialsPath(home: string, env: string): string {
  if (!ENV_NAME.test(env)) throw new Error(`kemory: invalid env name ${JSON.stringify(env)}`);
  return join(credentialsDir(home), `credentials-${env}`);
}

export function isApiKeyCredentials(c: CliCredentials): boolean {
  return c.issuer === "local" || c.client_id === "local";
}

/**
 * The text of the first JSON object in `text`: kemory-cli parses only that and
 * ignores trailing bytes (internal/config/credentials.go:75-96), because another
 * process may have rewritten the file in place.
 */
function firstJsonObject(text: string): string | null {
  const start = text.search(/\S/u);
  if (start === -1 || text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Null when the file is missing, unreadable, not the v2 format or incomplete. */
export async function readCredentials(home: string, env: string): Promise<CliCredentials | null> {
  let text: string;
  try {
    text = await readFile(credentialsPath(home, env), "utf8");
  } catch {
    return null;
  }

  const objectText = firstJsonObject(text);
  if (objectText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  if (raw.version !== VERSION) return null;
  if (typeof raw.expires_at !== "number" || !Number.isFinite(raw.expires_at)) return null;
  for (const key of REQUIRED_STRINGS) {
    if (typeof raw[key] !== "string") return null;
  }
  // The checks above are what make this a CliCredentials.
  const creds = raw as CliCredentials;

  return {
    ...creds,
    kemory_url: KEMORY_URL_REWRITES[creds.kemory_url] ?? creds.kemory_url,
    issuer: ISSUER_REWRITES[creds.issuer] ?? creds.issuer,
  };
}

/**
 * Writes the file the way the CLI does (internal/config/credentials.go:151-190):
 * a private temp file in the same directory, renamed over the target, so a reader
 * never sees half a file and a rotated refresh token is never half-saved.
 */
export async function writeCredentials(
  home: string,
  env: string,
  creds: CliCredentials,
): Promise<void> {
  const target = credentialsPath(home, env);
  const dir = credentialsDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const merged: Record<string, unknown> = { ...creds, version: VERSION };
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key];
  const text = JSON.stringify(sorted, null, 2);

  const temp = join(dir, `.credentials-${env}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

/**
 * Exchanges the refresh token at the issuer. Null means the issuer said no; a
 * network failure or an abort throws. Nothing here logs or embeds a token.
 */
export async function refreshCredentials(
  creds: CliCredentials,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CliCredentials | null> {
  const url = `${creds.issuer.replace(/\/+$/u, "")}/protocol/openid-connect/token`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
    }).toString(),
    redirect: "manual",
    signal,
  });
  const text = await res.text();
  if (res.status !== 200) return null;

  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof reply !== "object" || reply === null) return null;
  const { access_token, refresh_token, expires_in } = reply as Record<string, unknown>;
  if (typeof access_token !== "string" || access_token === "") return null;

  const lifetime = typeof expires_in === "number" && expires_in > 0 ? expires_in : 300;
  return {
    ...creds,
    access_token,
    // Keycloak may or may not rotate; the old token stays valid when it does not.
    refresh_token:
      typeof refresh_token === "string" && refresh_token !== ""
        ? refresh_token
        : creds.refresh_token,
    expires_at: Date.now() / 1000 + lifetime,
  };
}
