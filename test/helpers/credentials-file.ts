import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A version 2 login file as `kemory login` writes it; override any key per test. */
export function credentialsFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    access_token: "access-token-one",
    refresh_token: "refresh-token-one",
    // Epoch seconds, as a float: an hour from now.
    expires_at: Date.now() / 1000 + 3600.123456,
    issuer: "http://127.0.0.1:1/realms/s9n",
    client_id: "kemory-cli",
    kemory_url: "https://api.kemory.s9n.ai",
    email: "ada@example.com",
    active_org_id: "org-active",
    org_id: "org-home",
    ...overrides,
  };
}

export function credentialsFilePath(home: string, env = "prod"): string {
  return join(home, ".kemory", `credentials-${env}`);
}

/** Writes the file directly, so the tests do not depend on the code under test to set up. */
export function writeCredentialsFile(
  home: string,
  creds: Record<string, unknown>,
  env = "prod",
): void {
  mkdirSync(join(home, ".kemory"), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsFilePath(home, env), `${JSON.stringify(creds, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readCredentialsFile(home: string, env = "prod"): Record<string, unknown> {
  return JSON.parse(readFileSync(credentialsFilePath(home, env), "utf8")) as Record<
    string,
    unknown
  >;
}

/** The token endpoint path an issuer at the fake server's URL serves. */
export const TOKEN_PATH = "/protocol/openid-connect/token";
