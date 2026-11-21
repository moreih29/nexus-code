# @nexus-code/remote-protocol

The protocol between a NexusCode user's devices and the relay that connects them, as zod schemas.

There are two layers:

- **Relay frames** (`relay.ts`): what a device and its account's room on the relay send each other. The relay reads these: who a message is for, its sequence number, and the account key version it was sealed with. It cannot read the message itself.
- **Sealed messages** (`sealed.ts`, `rpc.ts`, `view.ts`): what a sealed frame carries between two devices of the account.
  - A `hello` that says which protocol version and capabilities a device serves.
  - JSON-RPC 2.0 requests, answers and notifications: list and watch sessions and their changes, read and drive chats, read, watch and drive terminals, wait on either, answer the consent prompts waiting on the user, read a workspace's files (find them by name, search their text, read them as text, images or bytes piece by piece) and git (status, diffs, log, a commit and its changes), and list a workspace's notes and put photos into one (with the note a device records into, in the sessions' list). What a device serves is per capability (`CAPABILITIES`); a hello's `schema` names the package version it speaks (`SCHEMA_VERSION`).
  - The chat view: the conversation as the serving device's app already built it, trimmed for drawing.

Beside them:

- **The account key's bundle** (`account.ts`): the account key locked with the account password, as the server keeps it. See `ACCOUNT_KEYS.md`.
- **The voice socket** (`voice.ts`): audio to the server, text back while the user speaks.
- **Push notifications** (`push.ts`, since 0.18.0) let phones register for APNs and computers ask the server to notify them. `/info.push` lists the API version and APNs environments. A computer that sends notifications advertises `push` in its hello. The notification's `nx` data carries the version and kind.
- **Codex client commands** (`commands.ts`): the slash commands a Codex client runs itself (`CODEX_COMMANDS`: name, aliases, argument hint) and the ones another device may run (`CODEX_REMOTE_COMMANDS`).

Sealing is XChaCha20-Poly1305. The key is the room key, derived from the account key. The associated data comes from `aadOf()` and binds a message to its routing. What is sealed is an envelope (`SealedEnvelopeSchema`): the message, the sender's epoch and the receiver's. Each connection to the relay has a random epoch, which devices learn from each other's hellos in three steps. A device takes a message only when it names its epoch now, is addressed to it, and has a seq higher than the last it took from that sender's epoch, so the relay cannot send an old message again or pass one on to another device. `sealed.ts` has the rules. Protocol version 2 (0.7.0) brought these; devices of version 1 open nothing of version 2.

Since schema 0.18.0 the envelope also carries `conn` (`SenderConnectionSchema`): `boot`, random and made once as the sender's room starts, and `n`, its connection count in that run, raised with each new epoch. A device takes nothing of a sender's epoch whose `conn` has the same `boot` as the one it heard last and an `n` no higher (`olderConnection()`). Otherwise a relay that held an older connection's messages and sent them after the newer's would turn the receiver back to the older epoch, and the receiver would drop the newer connection's messages until one of the two connected again. With another `boot` (the sender started again) or no `conn` on either side (a device before 0.18.0), the epochs alone decide, as before. The field is optional and devices before 0.18.0 leave it out when they parse, so the protocol version stays 2.

Schema 0.16.0 adds the `settings.instructions` capability and RPC. An agent can read the ordered instruction layers and combined text for a new chat in a workspace on another device when that device accepts agent requests. The read accepts an optional `profileId`. The capability also advertises support for `layer: "profile"` with a `profileId` in `settings.instructions.set`. Profile writes require fresh approval on the receiving device.

Schema 0.17.0 adds the `profiles.usage` capability and RPC. An agent can read the receiving device's profile names, usage windows, and observation times when that device accepts agent requests. The request can select a workspace host and refresh the snapshot through the provider's CLI.

Schema 0.19.0 adds optional fields only, and no capability. A chat's panel can carry `limitResume`: when the plan's usage limit stopped a subscription's chat, whether and when the serving app goes on in it by itself. A session can carry `limitWait`, the time it goes on. A turn's `retry` can carry `at`, `status` (the HTTP status) and `reason` (rate_limit, overloaded, server, connection, auth or other). Each is left out, not the panel or session, when a device cannot read it.

Schema 0.20.0 requires Zod 4 (`^4.6.6`) as a peer and keeps the 0.19.0 wire format.

Schema 0.20.1 adds optional `status.phaseRevision` and `panel.limitResume.stopAt` fields so remote banner dismissals can distinguish different failures or usage-limit stops with identical copy.

In schema 0.16.0, `chat.instructions` can also return `session`, the tab's editable session text, and `layers`, its ordered persistent layers, including empty layers. The workspace layer comes from the parent for a worktree task. Hosts through desktop 0.36.1 only return the combined `instructions` text. Treat a response without `session` as read-only. With `chat.control`, a person can replace the session layer using `chat.instructions.set`. Send an empty string to clear it. The 5,000-character limit applies to both people and agents. An edit with `from` follows the receiving device's agent approval policy.

Until it is published, other repos use it by a local path, e.g. `"@nexus-code/remote-protocol": "file:../nexus-code/packages/remote-protocol"`, after `npm run build` here: its exports point at `dist`.

## Use and publish

Published as `@nexus-code/remote-protocol`: ES modules with their type
declarations in `dist`. The desktop app
imports `src` directly; `npm run build` (run by `prepublishOnly`) makes
`dist`. Relative imports in `src` end in `.js`, as Node's ES modules need
them.

A version is published by GitHub Actions (`.github/workflows/publish-remote-protocol.yml`)
when a tag `remote-protocol-vX.Y.Z` naming the version in `package.json` is pushed:
trusted publishing, with no token or one-time password, and with provenance.
