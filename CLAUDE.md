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
- If `.git/config` is read-only, `git switch` prints "could not write config file" but still
  switches the branch. Commit and push still work.
- Run `pnpm install --frozen-lockfile` in a fresh clone before biome or vitest.
- `biome ci .` (`pnpm lint`) also checks Markdown formatting: it re-pads tables and removes the
  blank line between a paragraph and a following list. Run `pnpm format` after editing
  `README.md` or any other `.md` file, or lint turns red (an unformatted README did this to
  `main` at bc52182). `README.md` already exists on `main`: edit that file, don't add a new one.

## OpenClaw host behaviour

- OpenClaw 2026.10.5 rejects a bare `openclaw.install.minHostVersion` in `package.json` (such as
  `"2026.10.1"`) for non-bundled plugins and skips loading the plugin. Write it as `">=x.y.z"`
  (see `dist/min-host-version-*.mjs` in the `openclaw` package). `test/index.test.ts` checks this.
- OpenClaw resolves the manifest's `secretInputs` (including `ownerKind: "capability"`, and a
  SecretRef `apiKey`) into `api.pluginConfig` before `register` runs.
  `getPreparedPluginSecretInput` is the only per-call, reload-aware read, and it returns a
  value only when the authored config holds a SecretRef (see `dist/secret-input-runtime-*.mjs`).
- OpenClaw 2026.10.5 builds a different hook `ctx` at each call site of the same hook.
  `before_compaction` gets `{ sessionKey }` only on the embedded runtime's auto-compaction
  (`runBestEffortCompactionHook` in `dist/builtin-openclaw-*.mjs`), and no `memoryAudience` on
  queued compaction (`executeQueuedContextEngineCompaction` in `dist/embedded-agent-*.mjs`).
  Before gating a hook on `ctx` fields, grep every `run<HookName>(` call site in `dist`.
- OpenClaw 2026.10.5 keeps the session key, and in replies also the `sessionId`, across `/new`,
  `/reset` and idle/daily rotation, and `session_end` sets `nextSessionId` on compaction too.
  Decide session lifecycle by `event.reason`, not by the key or `nextSessionId`. Idle/daily
  rotation replays up to 6 old user/assistant messages into the new window (reset boundary
  `preserve-tail`); `/new` and `/reset` start a cleared window (`clear`). See
  `compaction-successor-*.mjs`, `session-reset-service-*.mjs`,
  `active-sessions-shutdown-tracker-*.mjs` and `session-accessor.sqlite-reset-boundary-*.mjs`.
- `src/capture/prompts.ts` mirrors OpenClaw's `stripInboundMetadata`, which changed in 2026.11.3
  (legacy `requester_profile` hint, CRLF trims). When the supported host range moves, diff
  `dist/strip-inbound-meta-*.mjs` across the releases (`npm pack openclaw@<version>`).

## Code

- Percent-encoding a dot as `%2E` does not keep it in a `fetch` URL path: the WHATWG URL parser
  treats `%2e`/`%2E` (and `.%2e`, `%2e.`) as dot segments and resolves them. To keep a
  caller-supplied id inside one path segment, refuse `''`, `'.'` and `'..'` instead of encoding
  them (see `DOT_SEGMENT_IDS` in `src/provider.ts`).
