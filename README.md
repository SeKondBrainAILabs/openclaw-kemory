# openclaw-kemory

Kemory memory plugin for [OpenClaw](https://openclaw.ai). Before each direct turn it loads your
Kemory context, and after the turn it saves your prompts to Kemory. It also adds four memory
tools: `kemory_search`, `kemory_store`, `kemory_forget` and `kemory_profile`.

Requires OpenClaw 2026.10.1 or later and Node.js 24.16 or later.

## Install

```sh
openclaw plugins install openclaw-kemory
```

## Sign in

The plugin needs a Kemory account. Use one of these:

- **`kemory login`** (recommended). Run it once on the host with the Kemory CLI. The plugin reads
  the credentials it stores and refreshes them when needed. `openclaw kemory status` prints the sign-in
  status.
- **An API key.** Create one with `kemory keys create --for openclaw --write`.
  Set the key as `apiKey` in the plugin config. `apiKey` is only needed when `kemory login`
  has not been run on this host.

`apiKey` is either a plain string or a SecretRef, so the key does not have to sit in your config
file:

```json
{
  "apiKey": { "source": "env", "provider": "default", "id": "KEMORY_API_KEY" }
}
```

`source` is one of `env`, `file`, `exec` or `store`. An environment placeholder that OpenClaw
did not expand (such as `${KEMORY_API_KEY}`) is ignored.

## Configuration

Set these under the `kemory` plugin entry in your OpenClaw config. All keys are optional.

| Key                  | Type                | Default                      | What it does                                                                                |
| -------------------- | ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `apiKey`             | string or SecretRef | none                         | Kemory API key. Not needed after `kemory login`.                                            |
| `env`                | string              | `KEMORY_ENV`, else `prod`    | Kemory environment whose credentials to use. Lower-cased.                                   |
| `baseUrl`            | string              | `https://api.kemory.s9n.ai`  | Kemory API address. When unset, the address stored by `kemory login` is used if there is one. |
| `autoRecall`         | boolean             | `true`                       | Load Kemory context before each turn.                                                       |
| `autoCapture`        | boolean             | `true`                       | Save your prompts to Kemory after each turn.                                                |
| `captureNamespace`   | string              | `user:sessions`              | Namespace the saved prompts go to.                                                          |
| `captureVisibility`  | string              | `user-private`               | Visibility of the saved prompts.                                                            |
| `contextMaxChars`    | integer, at least 500 | `4000`                     | Upper limit on the characters of context added to a turn.                                   |
| `contextNamespaces`  | array of strings    | `[]`                         | Namespaces to recall from.                         |
| `recallTimeoutMs`    | integer, 100–15000  | `2000`                       | How long to wait for context before a turn goes ahead without it.                           |
| `requestTimeoutMs`   | integer, 1000–60000 | `10000`                      | Timeout for other Kemory requests.                                                          |
| `debug`              | boolean             | `false`                      | Write debug messages to the plugin log.                                                                           |

Out-of-range numbers are clamped to the nearest limit; values of the wrong type fall back to the
default.

## Turning recall and capture off

Two environment variables switch the behaviour off for a process. They are the same switches the
`kemory hook` command honours, and they override the config:

- `KEMORY_CONTEXT=0` turns off loading context before each turn (`autoRecall`).
- `KEMORY_AUTO_CAPTURE=0` turns off saving prompts after each turn (`autoCapture`).

To turn either off permanently without environment variables, set `autoRecall` or `autoCapture`
to `false`. The memory tools stay available either way.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
