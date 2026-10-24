import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type Auth, NOT_SIGNED_IN } from "./auth.js";
import { KemoryError } from "./client.js";
import type { PluginDeps } from "./types.js";

function organisationLine(auth: Auth): string {
  if (auth.source !== "cli-login") return "set by the API key";
  return auth.orgId ?? "none (home organisation)";
}

function errorKind(err: unknown): string {
  if (err instanceof KemoryError) {
    return err.status === undefined ? err.kind : `${err.kind} ${err.status}`;
  }
  // Sign-in itself failed: a refresh that ran out of time or could not reach the issuer.
  return err instanceof DOMException && err.name === "AbortError" ? "timeout" : "network";
}

async function accountLine(deps: PluginDeps): Promise<string> {
  try {
    const { body } = await deps.client.request<{ email?: unknown; org_name?: unknown }>(
      "GET",
      "/api/v1/me",
      { timeoutMs: deps.config.requestTimeoutMs },
    );
    const email = typeof body?.email === "string" && body.email !== "" ? body.email : "unknown";
    const org = typeof body?.org_name === "string" && body.org_name !== "" ? body.org_name : "";
    return org === "" ? `account: ${email}` : `account: ${email} (${org})`;
  } catch (err) {
    return `account: error ${errorKind(err)}`;
  }
}

/** What `openclaw kemory status` prints. Never includes a token or key. */
export async function statusLines(deps: PluginDeps): Promise<string[]> {
  let auth: Auth | null;
  try {
    auth = await deps.auth.resolve(AbortSignal.timeout(deps.config.requestTimeoutMs));
  } catch (err) {
    return ["source: unknown", `env: ${deps.config.env}`, `account: error ${errorKind(err)}`];
  }
  if (!auth) return ["source: none", NOT_SIGNED_IN];

  return [
    `source: ${auth.source}`,
    `env: ${auth.env}`,
    `base url: ${auth.baseUrl}`,
    `organisation: ${organisationLine(auth)}`,
    await accountLine(deps),
  ];
}

export function registerCli(api: OpenClawPluginApi, deps: PluginDeps): void {
  api.registerCli(
    ({ program }) => {
      const kemory = program.command("kemory").description("Kemory memory: sign-in status");
      kemory
        .command("status")
        .description("Show which Kemory sign-in this plugin uses and who it is signed in as")
        .action(async () => {
          for (const line of await statusLines(deps)) process.stdout.write(`${line}\n`);
        });
    },
    {
      descriptors: [
        {
          name: "kemory",
          description: "Kemory memory: sign-in status",
          hasSubcommands: true,
        },
      ],
    },
  );
}
