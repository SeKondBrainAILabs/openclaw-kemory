# CLAUDE.md

Notes for working in this repo. `CONTRIBUTING.md` has the requirements, scripts and test setup;
this file holds the traps that are easy to miss.

## Toolchain

- pnpm and vitest need Node >= 24.16 (`engines` in `package.json`). If the machine's Node is
  older, install one locally without touching the system: `npm i --prefix /tmp/n24 node-linux-x64@24`,
  then put `/tmp/n24/node_modules/node-linux-x64/bin` first on `PATH`.
- `biome ci .` also lints `pnpm-lock.yaml` unless `files.includes` in `biome.json` excludes it
  with `"!pnpm-lock.yaml"`. Keep that entry.
- When `/tmp` is on a different filesystem from the checkout, `git clone --local` into it fails
  with "Invalid cross-device link". Use `git clone --no-hardlinks` instead.

## OpenClaw host behaviour

- OpenClaw 2026.10.5 rejects a bare `openclaw.install.minHostVersion` in `package.json` (such as
  `"2026.10.1"`) for non-bundled plugins and skips loading the plugin. Write it as `">=x.y.z"`
  (see `dist/min-host-version-*.mjs` in the `openclaw` package). `test/index.test.ts` checks this.
- OpenClaw resolves the manifest's `secretInputs` (including `ownerKind: "capability"`, and a
  SecretRef `apiKey`) into `api.pluginConfig` before `register` runs.
  `getPreparedPluginSecretInput` is the only per-call, reload-aware read, and it returns a
  value only when the authored config holds a SecretRef (see `dist/secret-input-runtime-*.mjs`).
