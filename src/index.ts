import { homedir } from "node:os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { createAuthProvider, NOT_SIGNED_IN } from "./auth.js";
import { registerCapture } from "./capture/index.js";
import { registerCli } from "./cli.js";
import { createKemoryClient } from "./client.js";
import { parseConfig } from "./config.js";
import { createLog } from "./log.js";
import { registerRecall } from "./recall.js";
import { registerTools } from "./tools.js";
import type { PluginDeps } from "./types.js";
import { VERSION } from "./version.js";

export default definePluginEntry({
  id: "kemory",
  name: "Kemory",
  description:
    "Kemory memory for OpenClaw: your Kemory context before each direct turn, your prompts saved after it, and memory tools.",
  // OpenClaw rejects an async register, and anything registered after it
  // returns is silently ignored. Async work belongs in the service's start.
  register(api) {
    const config = parseConfig(api.pluginConfig);
    const log = createLog(api.logger, { debug: config.debug });
    const home = homedir();
    // OpenClaw hands out a prepared SecretRef value only inside an invocation and
    // expects it to be read at use time, so it is read per call and never here.
    const auth = createAuthProvider(config, {
      log,
      home,
      readSecretApiKey: () => getPreparedPluginSecretInput("kemory", "apiKey")?.value,
    });
    const client = createKemoryClient(auth, { version: VERSION });
    const deps: PluginDeps = { config, client, auth, log, home };

    registerRecall(api, deps);
    registerCapture(api, deps);
    registerTools(api, deps);
    registerCli(api, deps);

    let warnedNotSignedIn = false;
    api.registerService({
      id: "kemory",
      async start() {
        try {
          const resolved = await deps.auth.resolve(AbortSignal.timeout(config.requestTimeoutMs));
          // A configured SecretRef that is not prepared yet is reported once by
          // the auth provider; "not signed in" would be the wrong message.
          if (!resolved && !config.apiKeyRef && !warnedNotSignedIn) {
            warnedNotSignedIn = true;
            log.warn(NOT_SIGNED_IN);
          }
        } catch (err) {
          log.failure("sign-in-check", err);
        }
      },
    });
  },
});
