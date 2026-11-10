# openclaw-kemory

A Kemory memory plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## What it does

- **Recall.** Before each direct turn from the agent's owner, it loads their Kemory context into the system prompt.
- **Capture.** After the turn, it saves the owner's own prompts to Kemory, with secrets redacted.
- **Tools.** It gives the agent `kemory_search`, `kemory_store`, `kemory_forget` and `kemory_profile`.

It only ever acts on the owner's direct conversations. See [Privacy](#privacy).

## Install

Requires OpenClaw 2026.10.1 or later and Node 24.16 or later.

```sh
openclaw plugins install openclaw-kemory
```

Then set this in your OpenClaw config:

```json5
{
  plugins: {
    slots: {
      memory: "kemory", // required
    },
    entries: {
      kemory: {
        hooks: {
          allowConversationAccess: true,
        },
      },
    },
  },
}
```

- `plugins.slots.memory: "kemory"` is required. OpenClaw uses the plugin's memory provider, and with it the check for whose conversation this is, only when the plugin is the selected memory slot. Without it, nothing runs.
- `plugins.entries.kemory.hooks.allowConversationAccess: true` lets the plugin read conversations for capture and recall.
- `plugins.entries.kemory.hooks.allowPromptInjection` must not be `false`: recall adds its context to the system prompt.

## Sign-in

The plugin looks for a credential on every request, in this order.
1. **`kemory login`.** Run it on the gateway host. The plugin reads the credentials the Kemory CLI stored in `~/.kemory/credentials-<env>` (`<env>` is `prod` unless you set `env` or `KEMORY_ENV`) and refreshes them in place, the way the CLI does, so the CLI and the plugin stay signed in together. Requests go to the organisation you chose with `kemory use`.
2. **An API key.** Create one with `kemory keys create --for openclaw --write` and set it as `plugins.entries.kemory.config.apiKey`, either as a string or as an OpenClaw SecretRef. The key's organisation is fixed when you create it. A key made without `--write` can search but not store, forget or capture.

A new key may come back with the status `pending_approval`. Until it is approved, Kemory answers every request with 401. The plugin still counts the key as a credential, so it does not show the not-signed-in message below. The tools reply `Kemory request failed (http 401); memory is unavailable right now.`, the gateway log carries a warning, and `openclaw kemory status` ends with `account: error http 401`.

The plugin never writes OpenClaw's config.

**When neither exists**, the gateway log says once at startup:

```
kemory: not signed in. Run "kemory login" on this host, or set plugins.entries.kemory.config.apiKey. Memory is off.
```

Recall and capture then skip quietly, and the tools return that same sentence. To see which credential is in use, which organisation it targets and who Kemory thinks you are, run:

```sh
openclaw kemory status
```

## What is captured and where

- Only prompts OpenClaw marks as the owner's own direct messages. Assistant replies and other senders' messages are never captured.
- Secrets are redacted with the same rules as the Kemory CLI (bearer tokens, API keys, passwords, private keys and similar patterns).
- Each save holds at most the last 12 new prompts and 8000 characters.
- Prompts are saved mid-session once 3 new ones have built up. Whatever is still unsent is flushed at compaction, at session end and at gateway shutdown.
- They are stored in the namespace `user:sessions` with visibility `user-private`, in the organisation your login or API key belongs to.
- A mark in `~/.kemory/.captured/` records what has been saved, so nothing is saved twice. It is written only after Kemory accepts a save, so a failed save is retried with a later turn.

Change the namespace and visibility with `captureNamespace` and `captureVisibility`.

## Recall

Before each owner turn the plugin fetches your Kemory context (the namespace summaries) and adds it to the system prompt, in a block marked as stored data rather than instructions. When the `kemory_search` tool is available, OpenClaw's memory prompt also tells the agent how to use the tools.
- The context is fetched once per session and cached for 10 minutes.
- The request has a 2 s deadline (`recallTimeoutMs`). If Kemory errors or is slow, the turn goes ahead without it, and the plugin makes no further recall requests for 60 s.
- `contextMaxChars` (default 4000) caps the size of the context. Summaries are added in the server's order and the rest are dropped, with a note saying how many.
- `contextNamespaces` limits the context to the namespaces you list.

Recall needs OpenClaw's embedded agent runtime. On CLI-backend agent runs OpenClaw sends no owner check, so nothing is loaded.

## Turning it off

| To stop          | Set                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Capture          | `plugins.entries.kemory.config.autoCapture: false`, or `KEMORY_AUTO_CAPTURE=0` in the gateway's environment |
| Recall           | `plugins.entries.kemory.config.autoRecall: false`, or `KEMORY_CONTEXT=0` in the gateway's environment       |
| The whole plugin | Unset `plugins.slots.memory`                                                                                |

The environment variables are the same ones the Kemory CLI's hooks use, and they win over the config. With `autoRecall` off, the context is no longer added, but the agent still gets the tools and the short memory instructions that go with them.

## Privacy

- Groups, channels, other senders, cron, heartbeat and incognito sessions never read or feed your memory. The plugin uses the owner check OpenClaw itself makes for each turn, and without it does nothing.
- **If anyone besides you can DM the agent**, set `session.dmScope: "per-channel-peer"`. Under OpenClaw's default, `main`, all direct messages share one conversation, so others in it can see replies that used your memory. Capture still keeps only your own messages from that conversation.
- Gateway, CLI and Control UI `memory.search` and `memory.get` calls are refused: they run with operator authority, which never gets your private memory.
- Content saved with `kemory_store` is not redacted. The agent stores what you ask it to, so keep secrets out of it.

## Tools

| Tool             | What it does                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `kemory_search`  | Searches your memory and returns matches with their `memory_id`. Takes `query`, and optionally `limit` (1 to 20, default 5) and `namespace`. |
| `kemory_store`   | Saves one fact or decision. Takes `content`, and optionally `namespace` and `tags`. Says so when Kemory already had it.                      |
| `kemory_forget`  | Deletes exactly one memory by the `memory_id` that `kemory_search` returned, never by query.                                                 |
| `kemory_profile` | Lists the summary of each namespace, or of one `namespace`.                                                                                  |

Every call has a hard deadline (`requestTimeoutMs`). A Kemory error or timeout is logged and returned to the agent as a short message; it never breaks the turn.

## Config reference

Set these under `plugins.entries.kemory.config`.

| Key                 | Default                                                  | Meaning                                                                           |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apiKey`            | none                                                     | A Kemory API key, as a string or SecretRef. Used when there is no `kemory login`. |
| `env`               | `KEMORY_ENV`, else `prod`                                | Which `~/.kemory/credentials-<env>` file to read.                                 |
| `baseUrl`           | the login's Kemory URL, else `https://api.kemory.s9n.ai` | The Kemory API address. Redirects are never followed.                             |
| `autoRecall`        | `true`                                                   | Add your Kemory context to each owner turn.                                       |
| `autoCapture`       | `true`                                                   | Save the owner's prompts after each turn.                                         |
| `captureNamespace`  | `user:sessions`                                          | Namespace that captured prompts go to.                                            |
| `captureVisibility` | `user-private`                                           | Visibility of captured prompts.                                                   |
| `contextMaxChars`   | `4000`                                                   | Size budget for the recalled context, in characters (at least 500).               |
| `contextNamespaces` | `[]` (all)                                               | Only recall these namespaces.                                                     |
| `recallTimeoutMs`   | `2000`                                                   | Deadline for the recall request, in ms (100 to 15000).                            |
| `requestTimeoutMs`  | `10000`                                                  | Deadline for capture and tool requests, in ms (1000 to 60000).                    |
| `debug`             | `false`                                                  | Log debug messages.                                                               |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
