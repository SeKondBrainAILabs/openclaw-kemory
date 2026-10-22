import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface FakeApi {
  api: OpenClawPluginApi;
  hooks: Map<
    string,
    { handler: (event: unknown, ctx: unknown) => unknown; opts?: { timeoutMs?: number } }
  >;
  tools: { tool: unknown; opts?: unknown }[];
  services: { id: string; start: (ctx: unknown) => unknown }[];
  cliRegistrars: { registrar: unknown; opts?: unknown }[];
  memoryCapabilities: unknown[];
  logs: { level: "debug" | "info" | "warn" | "error"; msg: string }[];
  runHook(name: string, event: unknown, ctx: unknown): Promise<unknown>;
}

export function createFakeApi(pluginConfig: Record<string, unknown> = {}): FakeApi {
  const logs: FakeApi["logs"] = [];
  const hooks: FakeApi["hooks"] = new Map();
  const tools: FakeApi["tools"] = [];
  const services: FakeApi["services"] = [];
  const cliRegistrars: FakeApi["cliRegistrars"] = [];
  const memoryCapabilities: unknown[] = [];

  const logger = {
    debug: (msg: string) => logs.push({ level: "debug", msg }),
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    error: (msg: string) => logs.push({ level: "error", msg }),
  };

  const api = {
    id: "kemory",
    pluginConfig,
    logger,
    on(
      name: string,
      handler: (event: unknown, ctx: unknown) => unknown,
      opts?: { timeoutMs?: number },
    ) {
      hooks.set(name, { handler, opts });
    },
    registerTool(tool: unknown, opts?: unknown) {
      tools.push({ tool, opts });
    },
    registerService(service: { id: string; start: (ctx: unknown) => unknown }) {
      services.push(service);
    },
    registerCli(registrar: unknown, opts?: unknown) {
      cliRegistrars.push({ registrar, opts });
    },
    registerMemoryCapability(capability: unknown) {
      memoryCapabilities.push(capability);
    },
  };

  return {
    // The fake implements only the registration surface this plugin uses.
    api: api as unknown as OpenClawPluginApi,
    hooks,
    tools,
    services,
    cliRegistrars,
    memoryCapabilities,
    logs,
    async runHook(name, event, ctx) {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`no hook registered for ${name}`);
      return await hook.handler(event, ctx);
    },
  };
}
