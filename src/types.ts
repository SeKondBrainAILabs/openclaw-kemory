import type { AuthProvider } from "./auth.js";
import type { KemoryClient } from "./client.js";
import type { KemoryConfig } from "./config.js";
import type { PluginLog } from "./log.js";

/** What every registration function receives; built once in `register`. */
export interface PluginDeps {
  config: KemoryConfig;
  client: KemoryClient;
  auth: AuthProvider;
  log: PluginLog;
  /** os.homedir() at register time. */
  home: string;
}
