# @nexus-code/remote-protocol

The protocol between a NexusCode user's devices and the relay that connects them, as zod schemas.

There are two layers:

- **Relay frames** (`relay.ts`): what a device and its account's room on the relay send each other. The relay reads these: who a message is for, its sequence number, and the account key version it was sealed with. It cannot read the message itself.
- **Sealed messages** (`sealed.ts`, `rpc.ts`, `view.ts`): what a sealed frame carries between two devices of the account.
  - A `hello` that says which protocol version and capabilities a device serves.
  - JSON-RPC 2.0 requests, answers and notifications: list and watch sessions and their changes, read and drive chats, peek at a chat's last turns, read, watch and drive terminals, wait on either, answer the consent prompts waiting on the user, read a workspace's files (find them by name, search their text, read them as text, images or bytes piece by piece) and git (status, diffs, log, a commit and its changes), and list a workspace's notes and put photos into one (with the note a device records into, in the sessions' list). What a device serves is per capability (`CAPABILITIES`); a hello's `schema` names the package version it speaks (`SCHEMA_VERSION`).
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

Schema 0.21.0 adds the `sessions.reorder` capability and RPC. Devices serve it alongside `sessions` for requests from people. Send `{ workspaceId, tabIds }` with up to 500 tab IDs. The host puts those tabs in the requested order in the slots they already occupy, skipping unknown and duplicate IDs, and returns `{}`. `sessions.list`, `sessions.watch` and `sessions.update` list each workspace's sessions in its agent sidebar order, followed by any remaining sessions in tab order.

Schema 0.22.0 adds optional `failed: true` to session listings when the last turn ended in error. The session's `state` stays compatible with older readers.

Schema 0.23.0 adds the `sessions.markSeen` capability and RPC. Devices serve it alongside `sessions` for requests from people. Their lists report unread chat and terminal results as `new-result`. Send the result's `since` back as `upTo` with `{ workspaceId, tabId }`, up to 500 entries in a request. Failed turns stay visible. The RPC returns `{ marked }`.

Session listings can include `incompleteWorkspaces` when a workspace's rows are partial or come from an earlier watch snapshot. Clients can wait for a complete listing before reconciling saved read receipts there.

Schema 0.24.0 adds optional `topLevel` to `git.status`, the absolute root from `git rev-parse --show-toplevel` (with forward slashes on Windows). Git file paths remain relative to that root. Readers can discard an invalid `topLevel` and keep the rest of the status.

Schema 0.25.0 adds optional `openedBy` to session listings and watch updates. It identifies the opener by tab and workspace, with a device ID for an opener on another computer. Large lists can omit opener names or the entire opener to fit the message limit. Older readers ignore the field.

Schema 0.26.0 adds `system.stats` and its capability: how busy a workspace's host is (CPU share in use, or null, and memory used and total in bytes), as its status bar shows. A device serves it only where it serves `files`, and only to people: a request with `from` is refused. Older hosts neither list the capability nor know the method.

Schema 0.27.0 adds `chat.peek` and its capability: a chat's last turns at a glance, for a preview. Send `{ workspaceId, tabId, turns? }`, 1 to 5 turns, 3 when left out. The serving device reads them from the chat's history without opening the tab, starting its program or connecting to a workspace's host, waits for no subagent and sends no tool results. Each turn has the user's message (up to 1,000 characters, with its image and file counts) or another sender's (up to 300), the agent's last words (up to 2,000) and its tool calls counted by name (the 8 most called, `otherTools` for the rest). `status` has `running`, `phase` and the end of the reply being written (up to 1,000). `more` says earlier turns exist, `waiting` what an open chat waits on, and `unavailable` why none could be read: `offline` for a host not connected, `missing` for no history. The answer, as JSON in UTF-8, fits in 14 KiB (`MAX_PEEK_BYTES`): the oldest turns go first, then replies, user texts, the reply being written and received texts are cut, in that order. Characters are code points, and a cut text ends with "…" (the reply being written begins with it). `fitPeek` makes the cuts and fits an answer in the budget, and `peekTools` counts a turn's tools. An agent's read carries `from`, as with `chat.read`. A device serves `chat.peek` only where it serves `chat.read`, and reads no more than `chat.read` does. Ask it only of a device whose hello serves `chat.peek`, and `chat.read` of one that does not.

Schema 0.28.0 adds `chat.runRead`: a page of one of a chat's `claude -p` or `codex exec` runs, read from the run's own session, as `chat.read` gives one of the chat. It needs the `chat.read` capability, finds the run only among the runs of the chat it names, and answers NotFound for any other run and for one that keeps no session. A request with `from` goes through the checks `chat.read`'s does. Older hosts do not know the method; `chat.run` still tells the run's summary.

Schema 0.29.0 takes the time limit off the consent prompts an agent's request (`from`) waits on. A host asks its user until they answer, the requester sends the `request.cancel` notification (`REQUEST_CANCEL`, `{ id }` of the request as last sent), or the requester leaves the room or comes back with a new connection; then it closes the prompt and does nothing. A requester waits for the answer without a limit and sends `request.cancel` when it stops waiting. Both do so only with a device whose hello says 0.29.0 or later (`UNTIMED_CONSENT_SCHEMA`); with an older one, the host still turns a prompt down after `AGENT_CONSENT_MS` and the requester waits that long. In the sessions' list, a host's untimed prompt has `expiresAt` a day past `at`, for older readers; a reader should not count prompts down nor drop them by time, as the next list leaves out a prompt that no longer waits. Such a prompt also carries `untimed: true`, so a reader can tell it from a prompt of an older requester, which a 0.29.0 host still turns down at `expiresAt` (90 seconds); the field is absent otherwise, and readers before 0.29.0 drop it as an unknown key. Older devices drop `request.cancel`.

A consent prompt in the sessions' list (`RemoteConsent`) is a change waiting on the user of the serving device. An agent of another device of the account may have asked for it, or a nexus command changing another workspace there, or that device's agent manager. The user answers it there, or from the device that lists it when `answerable` (`consent.answer`). An agent's request (`from`, `AgentSender`) to a control method takes the `agents` capability instead of the method's own. The serving device may ask its user first or turn the request down. `at` and `expiresAt` use the serving device's clock. `expiresInMs` is `expiresAt` minus the time the list was sent, so a reader needs no shared clock. A serving device before 0.29.0 turns a prompt down at `expiresAt` and drops it from the list. `AGENT_CONSENT_MS` (90 seconds) is how long a host asks a requester before 0.29.0 before turning the request down. Such a requester waits that long, plus a little more.

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
