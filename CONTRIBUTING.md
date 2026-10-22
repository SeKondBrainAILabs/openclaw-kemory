# Contributing

## Requirements

- Node.js >= 24.16
- pnpm (the version in `packageManager`; `corepack enable` picks it up)

## Scripts

| Command          | What it does                              |
| ---------------- | ----------------------------------------- |
| `pnpm lint`      | `biome ci .`: lint and format check       |
| `pnpm format`    | `biome check --write .`: apply fixes      |
| `pnpm typecheck` | `tsc --noEmit`                            |
| `pnpm test`      | `vitest run`                              |
| `pnpm build`     | `tsc -p tsconfig.build.json` into `dist/` |

Formatting and linting use [Biome](https://biomejs.dev). There is no Prettier or ESLint here.
TypeScript is strict, and relative imports use `.js` extensions.

## Tests

Tests start a fake Kemory server on 127.0.0.1 (`test/helpers/fake-kemory.ts`) and point the
plugin at it with `baseUrl`. They never contact a real Kemory host. Tests that touch
`~/.kemory` set `HOME` to a temporary directory (`test/helpers/temp-home.ts`).

Run lint, typecheck and tests one at a time on small machines; vitest is capped at two workers.

## Keeping in step with kemory-cli

The capture, redaction, context and credential rules in this plugin mirror
kemory-cli `internal/hook` and
`internal/config`. When a rule changes there, change it here too, and the other way round.
