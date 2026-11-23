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

Schema 0.14.0 adds the `files.write` capability and file writes from agents: `files.write.begin` names a destination file whose parent folder exists and its size (at most `MAX_FILE_WRITE_BYTES`) and gets an `uploadId`; `files.write.chunk` sends positioned base64 pieces; `files.write.end` checks the whole file's `sha256` and puts it in place; `files.write.abort` drops it. `files.mkdir` makes one folder, and is done when it already is one. `begin` and `mkdir` need an agent sender (`from`) and the method's capability, so a device serves `files.write` only where it takes agents' requests and chat control; the pieces, end and abort take `agents`, and an upload keeps the permission its begin got. The destination stays inside the workspace's folder and goes through no symbolic link. With `anywhere: true` (`FileScope.anywhere`), `files.list`, `files.read`, `files.write.begin` and `files.mkdir` take an absolute path on the serving device instead, and need `terminal.control`. Older devices do not know the methods and drop `anywhere`.

Schema 0.15.0 adds the `agents.cli` capability: a device takes the nexus CLI's reads from another device's agents (`from`, `ReadBy`) under the receiving device's agent policy. It adds `notes.read`, `notes.transcript` and `chat.instructions`, and `ReadBy` on `profiles.list` (which also takes `workspaceId` and tells `workspaceDefault` and `path`), `chat.settings`, `chat.commands`, `chat.panel` and `chat.tool` (which also takes `cli: true` for the CLI's form of a call and answers its `index`). `chat.fileSuggestions` moves from `chat.control` to `chat.read`, and `terminal.shells` from `terminal.control` to `terminal.read`. A CLI asks a device for these only when its hello lists `agents.cli`.

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

From schema 0.27.0, a host fills a workspace's `git` in the sessions' list (`RemoteWorkspaceSchema.git`: branch, ahead, behind, uncommitted) for a root workspace too, not only for a task; none where the folder is no repository. The wire format is unchanged: an older host tells it for tasks only, and a reader shows none where it is absent.

Schema 0.28.0 adds `chat.runRead`: a page of one of a chat's `claude -p` or `codex exec` runs, read from the run's own session, as `chat.read` gives one of the chat. It needs the `chat.read` capability, finds the run only among the runs of the chat it names, and answers NotFound for any other run and for one that keeps no session. A request with `from` goes through the checks `chat.read`'s does. Older hosts do not know the method; `chat.run` still tells the run's summary.

Schema 0.29.0 takes the time limit off the consent prompts an agent's request (`from`) waits on. A host asks its user until they answer, the requester sends the `request.cancel` notification (`REQUEST_CANCEL`, `{ id }` of the request as last sent), or the requester leaves the room or comes back with a new connection; then it closes the prompt and does nothing. A requester waits for the answer without a limit and sends `request.cancel` when it stops waiting. Both do so only with a device whose hello says 0.29.0 or later (`UNTIMED_CONSENT_SCHEMA`); with an older one, the host still turns a prompt down after `AGENT_CONSENT_MS` and the requester waits that long. In the sessions' list, a host's untimed prompt has `expiresAt` a day past `at`, for older readers; a reader should not count prompts down nor drop them by time, as the next list leaves out a prompt that no longer waits. Such a prompt also carries `untimed: true`, so a reader can tell it from a prompt of an older requester, which a 0.29.0 host still turns down at `expiresAt` (90 seconds); the field is absent otherwise, and readers before 0.29.0 drop it as an unknown key. Older devices drop `request.cancel`.

Schema 0.30.0 lets `chat.tool` and `chat.image` take an optional `runId`, the id `chat.runs` gives one of the chat's `claude -p` or `codex exec` runs. With it, the host looks for the tool call or image in that run's own session, as `chat.runRead` reads it, instead of in the conversation: a `toolUseId`, or a ref's `itemKey` and `toolUseId`, are then the ones a `chat.runRead` page gives. Both still need the `chat.read` capability. The host finds the run only among the runs of the chat it names and answers NotFound for any other run, a subagent, and a tool call or image the run does not hold; for a run that keeps no session to read it answers as `chat.runRead` does (Unavailable while a running run's session may still come, NotFound otherwise). A `held` ref with `runId` is never found. A host before 0.30.0 drops `runId` as an unknown key and looks in the conversation, so a reader sends `runId` only to a device whose hello says 0.30.0 or later (`RUN_ITEMS_SCHEMA`). No capability is added. The same version raises `PUSH_TTL_SECONDS.consent.max` from 120 to 86400 seconds: a computer sends the push for a consent prompt with no time limit for what is left of a day from the prompt's `at`, and for a prompt with a limit until that limit as before. A server before 0.30.0 clamps the TTL to 120 seconds; a computer that sees a consent push with a TTL over 120 refused with HTTP 400 sends it once more, with the same id and a TTL of 120. Every push for one consent prompt, a retry or the 120-second resend alike, carries the same `id` (`PUSH_EVENT_ID_PATTERN`), and a computer stops sending it once the prompt is answered or withdrawn. People may read `profiles.usage` from 0.30.0 on: a host that takes their requests lists the new capability `profiles.usage.people` (beside `profiles.usage`, which hosts since 0.17.0 list and which takes only agents' requests there); an agent's request is taken as before, under the `agents` capability and its policy. The answer is the same for both and carries no account email or keys: per profile its `id`, the `name` the user gave it, `agent`, `status`, `fetchedAt` and the usage `limits`.

Schema 0.31.0 lets a reader take a note's body and its recordings' transcripts apart, so a long transcript no longer keeps the body from coming: an answer over `MAX_FRAME_BYTES` is refused whole (Unavailable). `notes.read` takes an optional `withoutTranscript: true`: the host leaves `transcript` empty (`""`) and still sends `markdown`. Whether it is set or not, a 0.31.0 host adds `recordings`, one entry a recording of the note in the order `notes.transcript` gives them, empty for a note without one: `{ id, startedAt, ms, lines, participants }`, where `ms` is the recording's length in milliseconds, `lines` how many transcript lines it has (as `notes.transcript` counts them, before the Markdown joins a speaker's lines) and `participants` is `"auto"`, `"7+"` or a number. `transcriptOnly` and `withoutTranscript` together are refused (InvalidParams). `notes.transcript` takes optional `start` (a line index from 0) and `limit` (1 to `MAX_TRANSCRIPT_LINES`, 1000, which it also is when left out) to read one recording a page at a time; with either, `recording` is required (InvalidParams otherwise) and `recordings` holds that one recording. Each recording of a 0.31.0 host's answer carries `start`, the index of its first line here, and `total`, how many lines it has; without `start` and `limit` they are 0 and the count of the lines it sends, all of them. A page holds lines `start` up to `start + limit`, fewer where that is past the end or where more would not fit in a frame: the host leaves lines off the end until the answer fits, so a reader asks again from `start` plus the lines it got until it has `total`, and never takes a short page for the end. A `start` past the end answers no lines, with `start` set to `total`. Line `id`s are the same as in the whole transcript. A host answers Unavailable only when a single line does not fit. `notes.read` also reads a body a page at a time: with `withoutTranscript: true`, optional `markdownStart` (an index into `markdown` from 0) and `markdownLimit` (1 to `MAX_NOTE_MARKDOWN_PAGE`, 262144, which it also is when left out) send `markdown` from `markdownStart` for at most `markdownLimit` characters; either one without `withoutTranscript` is refused (InvalidParams). Indexes and lengths count UTF-16 code units, as JavaScript, Kotlin and Swift's `utf16` view index strings; the host never ends a page between the two halves of a surrogate pair, and a `markdownStart` that falls between them starts the page one unit earlier, so a page's `markdown` is always well-formed. A 0.31.0 host's `notes.read` answer always carries `markdownStart`, where its `markdown` begins, and `markdownTotal`, the length of the whole body (0 and that length when not reading by pages; 0 and 0 with `transcriptOnly`). A page holds fewer characters where more would not fit in a frame, so a reader asks again from `markdownStart` plus the length it got until it has `markdownTotal`, and joins the pages; a `markdownStart` past the end answers `markdown: ""` with `markdownStart` set to `markdownTotal`. Without `markdownStart` and `markdownLimit` a body that does not fit is still refused whole (Unavailable), not cut: a reader before 0.31.0 would drop `markdownTotal` and take a cut body for the whole one. The note's `recordings` come with every page. Every page carries the note's `updatedAt`, which changes whenever its body is saved: a reader compares each page's `updatedAt` (and `markdownTotal`) with the first page's and, when they differ, reads the body again from 0, giving up after a few tries if the note keeps changing; otherwise the joined body may match no one version of it. Before 0.33.0 a transcript page carries no such version, and saving a transcript does not change the note's `updatedAt`. A recording being recorded only grows, so a `total` larger than on an earlier page is normal and the reader goes on. A reader reads a recording again from 0 when a page's `start` is not the one it asked for, its `total` is smaller than before, or it repeats a line `id` already read; an edit that keeps the count and ids (a speaker renamed) is not seen until the next read, unless the host sends the `base` and `revision` of 0.33.0. `notes.list` adds `recordings` to each note, how many recordings it has (0 for none). The capability stays `notes`, and people and agents (`from`) may read as before; no capability is added. A host before 0.31.0 drops `withoutTranscript`, `markdownStart`, `markdownLimit`, `start` and `limit` as unknown keys and answers the whole note or transcript as before, which may then be refused as too large, and sends none of the new result fields; so a reader sends these keys only to a device whose hello says 0.31.0 or later (`NOTE_PAGES_SCHEMA`), and reads `recordings`, `markdownStart`, `markdownTotal`, `start` and `total` as absent from an older one. Readers before 0.31.0 drop the new result fields.

Schema 0.32.0 lets another device show two of a chat's banners as its own computer shows them: how the last turn failed, and a terminal tab running the same session. A chat's status adds optional `failure` while its last turn ended in a failure the app could name: `kind`, one of `TURN_FAILURE_KINDS` (`usage_limit`, `transient`, `auth`, `request`, `other`), `status`, the HTTP status when an answer came, and `at`, when the turn ended, in Unix milliseconds. It never carries the error's own words, a path or a token: those stay in the conversation's error notice as before. The host may keep sending it while a new turn runs and leaves it out once a turn ends without failing; a reader shows it only while no turn runs, as the desktop does: `transient` with a way to try again (chat.send of a message that asks the agent to go on from where it stopped), `auth` and `request` as an error with the status, and nothing for `usage_limit` (the plan limit's own banner says that) or `other`. A Claude chat's panel adds optional `twin`, `{ tabId }` of a terminal tab in the same workspace whose Claude Code runs the same session, as its hooks told the host: going on in both forks the conversation. The host sends the panel again in chat.update when a terminal starts or stops running the session, and tells only a terminal tab, never another chat. A reader shows that terminal where the sessions' list lists it, as it opens any listed terminal. A `failure` of a kind this version does not know, or one or a `twin` it cannot read, is left out, not the status or the panel. A host before 0.32.0 sends neither and a reader before 0.32.0 drops both, so a reader shows the banners only where they come; no method, capability or schema constant is added, and `chat.read` and `chat.control` serve them as before.

Schema 0.33.0 lets a reader see that a recording's transcript changed between the pages it reads even where its line count and line `id`s stay the same: a speaker renamed (by hand or from a remembered voice), a line's text or speaker changed, or its `participants` set. Each recording of a `notes.transcript` answer adds optional `base` and `revision`, short opaque strings: `revision` names the recording's lines from 0 through the last line of this answer, and `base` its lines before `start`, each as it is when the host answers, with every line's `speakerName`, `speakerLabel` and text and the recording's `participants`. Equal strings mean the same lines; a reader only compares them and never parses them or works one out itself. Without `start` and `limit`, `base` names no lines and `revision` all of them. A recording being recorded keeps the lines it had while it grows, so the `base` of its next page is the `revision` the reader holds and the reader goes on. A reader keeps the `revision` of the last page it took and, when the next page's `base` differs from it, reads that recording again from 0, as for a `start` it did not ask for, giving up after a few tries as before. Each entry of `notes.read`'s `recordings` adds the same `revision`, naming all the recording's lines: a reader that has read a recording's transcript compares the `revision` of its last page with the note's and, when they differ, asks for the note's `recordings` again to show the length and line count of the version it read. The host works both out from what it sends each time (now the first 16 hex digits of a SHA-256); nothing is stored, and saving a transcript changes them only where its lines, names or `participants` change. One that is not a string of 1 to 64 characters is left out, not the recording. A host before 0.33.0 sends neither and a reader before 0.33.0 drops both, and a reader compares them only where both values come, reading as before otherwise; so no method, capability or schema constant is added, and a reader still pages only a device whose hello says `NOTE_PAGES_SCHEMA` or later.

Schema 0.34.0 lets another device show a chat's changed file as the chat's own computer shows it: as the agent wrote it in the tool call. Each entry of a chat panel's `changedFiles` adds optional `rawPath`, the path as the first finished change of that file named it, sent only where it differs from `path`. `path` stays the key: the host still groups a file's changes by it and opening the file or its change still takes it. Today the two differ only in how a Windows path is written: `path` has forward slashes and an upper-case drive letter (`C:/p/a.ts`, `//server/share/x.ts`), `rawPath` the agent's backslashes and case (`c:\p\a.ts`, `\\server\share\x.ts`), so it tells nothing `path` does not. A reader shows `rawPath` where it comes, made relative to the chat's folder as for `path`, and `path` otherwise. One that is not a string is left out, not the file. A host before 0.34.0 sends none and a reader before 0.34.0 drops it, so a reader shows `path` as before; no method, capability or schema constant is added.

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

## API reference

What each module and export means, by file in `src`. A name with dots is a field or member of the export before it; "(how it works)" marks what a function does inside.

### `index.ts`

NexusCode's remote protocol, in two layers, and the account key's bundle:
- ./relay: the frames between a device and its account's room on the
  relay, which the relay reads and routes;
- ./sealed, ./rpc, ./view: what a sealed frame carries between two
  devices of the account, which only they can open; ./peek fits a
  chat.peek answer in its budget;
- ./account: the account key, locked with the account password, as the
  server keeps it;
- ./device-keys: each device's key, envelopes and rotation, pairing, and
  the password's proof (account keys v2);
- ./voice: the voice socket, speech to text while the user speaks;
- ./push: phone registrations, notification requests and app data;
- ./info: what the server offers (GET /info);
- ./commands: the slash commands a Codex client runs itself.

### `relay.ts`

What the relay sees: the frames between a device and its account's room.
A device sends sealed messages to another device of the account, or to
all of them; the relay checks who sent it, stamps it, and passes it on.
It cannot open what a message carries (see ./sealed.ts).

**`RELAY_VERSION`**

The version of the frames below; the relay refuses a device that speaks
another. A device asks for its ticket with it (POST /relay/ticket?v=2) and
opens the socket with it (/relay?v=2&ticket=...). A version the server no
longer takes is turned down at the ticket, where a status can be read:
400 with UnsupportedVersionSchema's body. That app must be updated; asking
again will not help. Version 2 is NexusCode 0.12.0's: its account keys v2
only, and the protocol package's 0.12.0 or later.

**`UNSUPPORTED_VERSION`**

The ticket's answer to a version it no longer takes (400): the one it wants.

**`DeviceIdSchema`**

A device's id, as the server gave it when the device signed in.

**`ALL_DEVICES`**

Every other device of the account that is in the room.

**`Base64UrlSchema`**

Unpadded base64url, as the sealed bytes travel.

**`OutgoingSchema`**

A sealed message, as the sender gives it to the relay. `to` is one device
or ALL_DEVICES. `seq` counts the sender's messages since it connected,
from 1: the other side takes them in its order, each once (see
./sealed.ts). `kid` is the account key's version the message was sealed
with, or PAIR_KID (0) for a pairing frame, which goes to one device only
(see ./device-keys.ts): the relay refuses one to ALL_DEVICES.

**`DeliveredSchema`**

A sealed message as the relay delivers it, with the sender it vouches for.

**`RoomDeviceSchema`**

A device of the account, as the relay tells who is in the room.

**`RoomDeviceSchema.name`**

The name the device signed in with (its host's, say).

**`RoomDeviceSchema.alias`**

The name the user gave it, shown in its place (alias ?? name), with
`name` beside it where devices are looked at closely; null or absent
for none. A server before 0.11.0 sends none. Since 0.11.0.

**`RoomDeviceSchema.platform`**

darwin, win32, linux, ios, android, web.

**`PresenceSchema`**

Who is in the room: sent once a device joins, and again whenever a device
comes or goes. `self` is the device it is sent to.

**`RelayErrorSchema`**

The relay could not take a frame: it was malformed, too big, sent to a
device not in the room, or the device's sign-in ended (then the relay
closes the socket after it).

**`RelayErrorSchema.seq`**

The seq of the frame it refuses, when it was a message.

**`AccountEventSchema`**

Something that befell the account, which the server tells every device
in the room (account keys v2):
- key-rotated: a rotation put the account key of version `kid` in place;
  a device fetches its envelope (GET /devices/current/key-envelopes);
- key-reset: a reset that waited is in place (version `kid`);
- reset-pending: a reset was asked for without the password, and is put
  in place at `appliesAt` unless called off;
- reset-cancelled: it was called off.
A device before v2 does not know the frame and drops it.

**`ClientFrameSchema`**

What a device sends the relay.

**`ServerFrameSchema`**

What the relay sends a device.

**`MAX_FRAME_BYTES`**

Most bytes one frame may take as JSON. A chat's whole transcript goes in
pages under it (see ./rpc.ts).

### `sealed.ts`

What a sealed message carries, which only the account's devices can open.

Sealing (v2): XChaCha20-Poly1305 with the room key, a fresh random 24-byte
nonce per message, and the frame's routing as associated data (aadOf), so
the relay can neither read a message nor pass it off as another's. The
room key comes from the account key (see the account key design); every
device of the account holds it. The bytes sealed are an envelope's JSON
in UTF-8 (SealedEnvelopeSchema): the message, and the epochs below.

The relay may keep a frame and send it again, then or days later, or to
another device of the account. So a device takes a message only when it
was sealed for it, now, and only once:

- Each connection to the relay has an epoch, random, made as it opens.
  An envelope names the sender's epoch (`epoch`) and the epoch of the
  device it goes to (`peer`), as that device told it.
- A device takes a message only when `peer` is its own epoch now (one
  sealed before this connection opened names another), and `to` is itself.
- It takes a sender's messages only in the order of their seq, each once:
  a seq no higher than the last it took of that sender's epoch is not
  taken; once it took one of a sender's newer epoch, it takes none of an
  older one.
- Since 0.18.0 an envelope also says which of its sender's connections
  it comes in (`conn`: the sender's run, and its connections counted in
  that run). A device takes nothing of a sender's connection older than
  one it took of the same run, even one it never heard before: else a
  relay that held an older connection's messages, and sent them on after
  the newer's, would turn the device back to the older epoch, and it
  would drop all of the newer till one of the two connected again. Of
  another run, or with no `conn` (a device before 0.18.0), it goes by
  the epochs alone, as before.

A device learns another's epoch from a hello sent to it, in three steps:
1. As it joins, A sends ALL_DEVICES its hello with `peer: null`. No one
   can tell it is not an old one sent again, so it only asks for theirs.
2. B answers A alone with its hello: `peer` A's epoch, `reply: true`.
   A takes it, and so knows B's epoch.
3. A answers B with its hello: `peer` B's epoch, `reply: false`. B takes
   it, and so knows A's.
Any hello whose `peer` is not the receiver's epoch now is answered as in
step 2, and is not otherwise taken. Requests, answers and notifications go
to one device, with its epoch; none goes to a device whose epoch is not
known yet. An answer goes in the epoch its request came in.

**`PROTOCOL_VERSION`**

The version of what is sealed; a device tells it in its hello, and it is
in the associated data, so a device of another version opens nothing.

**`SCHEMA_VERSION`**

This package's version, which a device tells in its hello (`schema`):
the methods a device serves are those of its version, so another can
leave out what an older one does not have. Kept equal to package.json's.

**`ROOM_KEY_INFO`**

The HKDF info that makes the room key from the account key.

**`aadOf`**

The associated data a message is sealed with: its routing, as the relay
delivers it. A message the relay sends on to another device, or with
another seq, does not open.

**`CAPABILITIES`**

What a device can do for another, as it says in its hello. The other
side asks only for what is listed; a newer device lists more.

**`CAPABILITIES`**

sessions.list and sessions.watch, profiles.list.

**`CAPABILITIES`**

sessions.reorder, for the user wherever sessions is served. Since 0.21.0.

**`CAPABILITIES`**

User read receipts alongside sessions, with host unread results for chats and terminals. Since 0.23.0.

**`CAPABILITIES`**

Reading a chat: chat.read and chat.watch, its settings, commands, panel, images, tool calls; history.list.

**`CAPABILITIES`**

Acting in a chat: sending, answering, stopping, settings, commands, opening, resuming,
renaming, closing; and answering the consent prompts waiting on the user.

**`CAPABILITIES`**

terminal.read and terminal.watch: a terminal's screen, as text.

**`CAPABILITIES`**

Typing into a terminal, opening, renaming and closing one.

**`CAPABILITIES`**

files.list, files.read, files.find and files.search, in a workspace's folders.

**`CAPABILITIES`**

Workspace file writes and directory creation, with agent control. Since 0.14.0.

**`CAPABILITIES`**

git.status, git.diff, git.log and git.show of a workspace.

**`CAPABILITIES`**

notes.list and notes.attach: a workspace's notes, and photos put into one.

**`CAPABILITIES`**

folders.list and workspace.create: going through the device's folders
and adding one as a workspace. Only the user's: an agent's request is
refused. Served while chat.control is. Since 0.12.0.

**`CAPABILITIES`**

Takes agents' requests (`from`: nexus on another device) to act in its
chats and terminals, as the user set it (Settings › Remote: ask or
allow). A request with `from` needs it and the method's own capability
(chat.control, terminal.control) both: an agent may do no more than
people may from other devices. One with `from` from a phone (ios,
android, web) is refused: no agent runs there.

**`CAPABILITIES`**

Extended agent CLI operations, since 0.15.0.

**`CAPABILITIES`**

Read the layers for a new chat and edit profile layers, since 0.16.0.

**`CAPABILITIES`**

Read profile subscription limits, since 0.17.0.

**`CAPABILITIES`**

Sends push notifications to the account's phones for what waits on the user here. Since 0.18.0.

**`CAPABILITIES`**

system.stats: how busy a workspace's host is. Only the user's: an
agent's request is refused. Served only where files is. Since 0.26.0.

**`CAPABILITIES`**

chat.peek: a chat's last turns at a glance, read without opening it. A
device serves it only where it serves chat.read, and reads no more
than chat.read does; an agent's request (`from`) is taken as chat.read's
is. Since 0.27.0.

**`CAPABILITIES`**

profiles.usage.people: profiles.usage is taken from people too, not
only from agents. Served wherever profiles.usage is. Since 0.30.0.

**`HelloSchema`**

A device introduces itself: to all the room as it joins, and to one that
just joined. What it serves of its own sessions is `serves`; a device
that only watches others (a phone) serves nothing.

**`HelloSchema.app.theme`**

The app's color theme now, by its id ("github-dark"): a phone may follow it.

**`HelloSchema.schema`**

The protocol package's version it speaks (SCHEMA_VERSION, "0.7.1");
absent before 0.2.0. A method it does not have is answered MethodNotFound.

**`HelloSchema.reply`**

Whether it wants the other's hello back: true as it joins (to all), and
as it answers a hello it could not take (see the top of this file).

**`SealedMessageSchema`**

A sealed message's content.

**`EPOCH_BYTES`**

The random bytes of a connection's epoch, which goes as unpadded base64url.

**`EpochSchema`**

A connection's epoch (see the top of this file).

**`SenderConnectionSchema`**

Which of its sender's connections a message comes in (see the top of
this file). Since 0.18.0.

**`SenderConnectionSchema.boot`**

The sender's run: random, as an epoch is, made once as its room starts.

**`SenderConnectionSchema.n`**

The connection's number in that run, counted from 1: each new one is higher.

**`olderConnection`**

Whether a message of a sender's epoch not heard yet comes in a connection
older than the one of the epoch heard of it now, so it is not taken: only
when both say their connection, of the same run.

**`SealedEnvelopeSchema`**

What is sealed: a message, with the epochs that tell it fresh (see the top of this file).

**`SealedEnvelopeSchema.epoch`**

The sender's epoch now.

**`SealedEnvelopeSchema.conn`**

The sender's connection it comes in; absent before 0.18.0.

**`SealedEnvelopeSchema.peer`**

The receiver's epoch, as it told it; null only in a hello to ALL_DEVICES.

### `rpc.ts`

What one device asks another, sealed: JSON-RPC 2.0 requests, their
answers, and the notifications a watch sends. The device that runs the
sessions serves; the one that shows them asks.

A session is named by the serving device's own ids: its workspace's and
its tab's. The same folder has other ids on another device.

#### JSON-RPC 2.0 shapes

**`RpcResponseSchema`**

The error first: `result: z.unknown()` takes an object without one too,
and would strip an error answer's `error`.

**`RpcErrorCode`**

The error codes: JSON-RPC's own, and the protocol's from 1000.

**`RpcErrorCode.NotFound`**

No such workspace, tab or watch on the serving device.

**`RpcErrorCode.Forbidden`**

The serving device does not let this device do it.

**`RpcErrorCode.Unavailable`**

The session cannot do it now: a chat with no request waiting, one whose program is gone.

#### Sessions

**`readableList`**

A list a newer version may add to: an item this version cannot read, as
one of a kind or state it does not know, is left out rather than failing
the whole answer, and the list is cut to `max`. So a device of a newer
version that adds an agent's state hides that agent from an older one,
not every session of the computer. Since 0.12.1.

**`RemoteWorkspaceSchema`**

A workspace of the serving device.

**`RemoteWorkspaceSchema.path`**

Its folder, on the serving device.

**`RemoteWorkspaceSchema.parentId`**

A task: a workspace on a git worktree of the workspace `parentId`, on its own branch.

**`RemoteWorkspaceSchema.manager`**

The agent manager's own workspace, where the session that directs the others runs.

**`RemoteWorkspaceSchema.pinned`**

Pinned to the top of the sidebar. The list comes in the sidebar's
order (pinned first, a task after its workspace). Since 0.11.0.

**`RemoteWorkspaceSchema.git`**

Its branch and how it stands against its upstream, with how many files
it changed and did not commit. Looked at now and then, not live. A
device may tell it for tasks only, and none where it is no repository.

**`SessionStateSchema`**

Where a session stands, as the agent lists show it.

**`MAX_SESSION_AGENTS`**

Most agents a session's entry lists.

**`MAX_AGENT_DESCRIPTION`**

Longest an agent's description is, in characters.

**`MAX_CHAT_RUNS`**

Most `claude -p` and `codex exec` runs chat.runs tells.

**`MAX_RUN_TEXT`**

Longest a run's prompt, answer or message is told, in characters.

**`ChatRunSchema`**

A `claude -p` or `codex exec` run a chat's session started, as the
serving app recorded it and its chat shows it beside its subagents: as
chat.runs lists it, what its row shows; chat.run tells its tools,
messages and answer too.

**`ChatRunSchema.program`**

"codex" for a `codex exec` run; absent for `claude -p`.

**`ChatRunSchema.endpoint`**

Where its model is served when not by its program's own API: the gateway's host.

**`ChatRunSchema.prompt`**

What it was asked: its start, as chat.runs tells it; all of it (to MAX_RUN_TEXT) from chat.run.

**`ChatRunSchema.toolsTold`**

Whether its tools are told (its output is a stream of events).

**`ChatRunSchema.sessionId`**

Its session's id, which chat.resume goes on with in a tab of its own.

**`ChatRunSchema.current`**

The tool it runs now, as "Bash npm test"; from chat.runs.

**`ChatRunSchema.last`**

What it wrote last: its answer once it ended; its start, from chat.runs.

**`ChatRunSchema.tools`**

Its latest tools, oldest first; from chat.run.

**`ChatRunSchema.messages`**

Its latest messages, oldest first; from chat.run.

**`ChatRunSchema.answer`**

Its answer, once it ended; from chat.run.

**`RemoteSessionAgentSchema`**

An agent a session runs beside its turn, as the serving app's agent list
shows it under the session's row: a subagent of its Claude Code, or a
`claude -p` or `codex exec` run started inside it ("print").

**`RemoteSessionAgentSchema.id`**

The subagent's agent_id, or the run's own id.

**`RemoteSessionAgentSchema.program`**

For a run: the program it runs; "codex" for a `codex exec` run.

**`RemoteSessionAgentSchema.type`**

The subagent's type, as "Explore".

**`RemoteSessionAgentSchema.description`**

What it was asked to do, on one line; for a run told nothing more, its prompt's start.

**`RemoteSessionAgentSchema.start`**

When it started, in Unix milliseconds.

**`RemoteSessionSchema`**

An agent session or terminal of the serving device.

**`RemoteSessionSchema.failed`**

The last turn ended in error. Keep state as before for older readers. Since 0.22.0.

**`RemoteSessionSchema.since`**

When it came to that state, in Unix milliseconds. Hosts serving sessions.markSeen
report unread chat and terminal results as new-result, with their result time here.
Return that time as upTo to mark the result seen. Failures keep their prior state.

**`RemoteSessionSchema.last`**

The last thing it said, a line.

**`RemoteSessionSchema.profile`**

The agent profile it runs with.

**`RemoteSessionSchema.cwd`**

The folder a chat runs in, when it is not its workspace's (a folder
under it, or one it was given): its links are written from there.
Since 0.11.0.

**`RemoteSessionSchema.agent`**

The agent a terminal runs (claude, codex), or another that notifies
("agent"); absent for a terminal that only has its shell, which the
lists keep out of sight until asked for. Never on a chat.

**`RemoteSessionSchema.waiting`**

What it waits on the user for, when it does. Since 0.12.1, one this
version cannot read (a kind it does not know) is left out, and the
session stays: one that waits on the user is the last to hide.

**`RemoteSessionSchema.waiting.requestId`**

A terminal's Claude Code asking: the request terminal.answer answers.

**`RemoteSessionSchema.waiting.always`**

With a requestId: whether its Claude Code offers to allow it always
(terminal.answer's allowAlways). Since 0.13.2; absent before, when
it may or may not.

**`RemoteSessionSchema.waiting.subagent`**

With a requestId: a subagent's request, for which denyStop cannot
stop the turn. Since 0.13.2; absent before, when it may be one.

**`RemoteSessionSchema.agents`**

The agents it runs beside its turn that still run, as the serving app
lists them under its row; at most MAX_SESSION_AGENTS, absent with none.
A chat's or a terminal's Claude Code (or Codex) session alike. Since
0.12.0; since 0.12.1 one this version cannot read is left out, and
more than MAX_SESSION_AGENTS are cut (readableList).

**`RemoteSessionSchema.openedBy`**

The agent that opened this session. Its IDs are on the serving device
unless device names the Room ID of another computer. Names and the
whole opener may be left out to fit a listing in one frame. Since 0.25.0.

**`RemoteSessionSchema.limitWait`**

A chat the plan's usage limit stopped, which its app goes on in by
itself at `at` (Unix milliseconds), once the limit resets. Since
0.19.0; one this version cannot read is left out, not the session.

**`ConsentAnswerSchema`**

How the user answers a consent prompt: this once, until the serving app restarts, or no.

**`RemoteConsentSchema.at`**

When it was asked, by the serving device's clock (Unix ms).

**`RemoteConsentSchema.from`**

Who asks.

**`RemoteConsentSchema.from.device`**

An agent of another device of the account; absent: one of the serving device's own.

**`RemoteConsentSchema.from.manager`**

The serving device's agent manager asks.

**`RemoteConsentSchema.from.workspaceName`**

The asking workspace's name, when it is one of the serving device's.

**`RemoteConsentSchema.from.name`**

The asking tab's title.

**`RemoteConsentSchema.workspaceId`**

The serving device's workspace it would change.

**`RemoteConsentSchema.change`**

What it would do: `kind` as the serving device names it (chatInput,
terminalInput, tabClose, permissionAllow, ...; new ones may come), a
line on what to, and the whole of it when a line does not tell it (a
command to allow or run, what would be typed, a message or a prompt).
A body too long to tell whole (the desktop's past 8000 characters)
comes cut short, and the prompt is not answerable.

**`RemoteConsentSchema.eachTime`**

It is asked about each time: "session" is not an answer to it.

**`RemoteConsentSchema.answerable`**

Whether the device the list goes to may answer it: one that serves it
chat.control, and terminal.control too for a change to a terminal. The
device whose agent asks may too, as its user (an older serving device
says false to it): consent.answer is not taken from agents.

**`RemoteRecordingSchema`**

A note the serving device records into: a phone shows it, and may put
photos into the note (notes.attach) while the meeting goes on.

**`RemoteRecordingSchema.title`**

The note's title; empty for a note not named yet.

**`RemoteRecordingSchema.recordedMs`**

How long it had recorded at `at`, in milliseconds.

**`RemoteRecordingSchema.at`**

When it was counted, by the serving device's clock (Unix milliseconds).

**`RemoteRecordingSchema.paused`**

Paused: `recordedMs` stays as it is until it records again.

**`SessionsSchema.sessions`**

Since 0.12.1, a session this version cannot read (a kind or state it does not know) is left out.

**`SessionsSchema.incompleteWorkspaces`**

Workspaces whose rows may be partial or retained from the last good watch snapshot.

**`SessionsSchema.consents`**

The consent prompts waiting on the user, in the order they are asked;
absent before 0.3.0. Since 0.12.1, one this version cannot read is left out.

**`SessionsSchema.recording`**

The note it records into, while it records; absent before 0.6.0.

**`TabRef`**

A session of the serving device, by its ids there.

**`AgentSenderSchema.kind`**

tab: a Claude or Codex tab; terminal: an agent in a terminal; manager: the agent manager.

**`AgentSenderSchema.name`**

Its tab's title, as the receiver shows the sender.

**`AgentSenderSchema.waits`**

With chat.send: whether the sender waits for the answer (chat send
--wait), and so reads what the agent answers in its tab, or sent and
went on, and is to be written back to. Since 0.13.0; an older device
leaves it out, and the agent is told the sender may be waiting.

**`ReadBy`**

The agent that reads, when one does (nexus chat read on another device):
a read with it is taken only where agents' requests are (the `agents`
capability), with no prompt, so a device whose user turned agents down
is read by people alone. Since 0.12.0; an older device turns down a read
with it, so it goes only to one of 0.12.0 or later.

**`TERMINAL_KEYS`**

The keys terminal.input presses by name, as `nexus terminal key` names them.

**`RUN_ITEMS_SCHEMA`**

The first schema version whose hosts take `runId` in chat.tool and
chat.image (0.30.0). A reader compares a device's hello `schema` with it.

**`NOTE_PAGES_SCHEMA`**

The first schema version whose hosts take `withoutTranscript`,
`markdownStart` and `markdownLimit` in notes.read and `start` and `limit`
in notes.transcript, and answer a note's `recordings`, `markdownStart` and
`markdownTotal` and each recording's `start` and `total` (0.31.0). A
reader compares a device's hello `schema` with it; an older host drops
those keys and answers the whole note or transcript.

**`MAX_AGENT_REQUESTS_PER_MINUTE`**

Most requests with `from` one agent (a device's tab) may make a minute; more are Unavailable.

**`MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE`**

Most requests with `from` all of one device's agents may make a minute:
a device names its agents itself, so a new name each time does not get
past this.

**`MAX_WAIT_MS`**

Longest a chat.wait or terminal.wait holds before it answers that the session is not done yet.

**`ChatWaitStateSchema`**

Where a chat stands for one that waits on it, as `nexus chat wait` tells it.

**`SessionEventSchema`**

A session state change, as `nexus events` lists them.

**`SessionEventSchema.seq`**

Counts the device's events from 1 since its app started.

**`SessionEventSchema.from`**

The phase it left (null: first seen) and the one it came to ("closed" when the tab went).

Most images and files one message takes.

**`MAX_FOLDERS`**

The most folders folders.list gives.

**`MAX_UPLOAD_BYTES`**

Most bytes one file chat.upload takes (since 0.10.0): as many as a file
dropped on the desktop's own composer.

**`MAX_ATTACHMENT_BYTES`**

Most bytes one image chat.attach takes, before base64: its base64 and the
request around it stay inside a frame (MAX_FRAME_BYTES, sealed).

**`MAX_IMAGE_EDGE`**

The longest side chat.image may be asked to draw an image at, in pixels.

**`ImageMediaTypeSchema`**

The image types a chat takes.

**`MAX_LISTED_NOTES`**

Most notes notes.list gives.

**`MAX_TRANSCRIPT_LINES`**

Most lines a page of notes.transcript gives (1000), and the most `limit`
may ask for. A page has fewer where more would not fit in a frame.
Since 0.31.0.

**`MAX_NOTE_MARKDOWN_PAGE`**

Most characters (UTF-16 code units) of a note's body a page of notes.read
gives (262144), and the most `markdownLimit` may ask for. A page has
fewer where more would not fit in a frame. Since 0.31.0.

**`NoteRecordingInfoSchema`**

A recording of a note, as notes.read lists it since 0.31.0: `id` (to give
notes.transcript as `recording`), `startedAt` (Unix milliseconds), `ms`
(its length in milliseconds), `lines` (how many lines notes.transcript has
for it, its `total`), `participants` (`"auto"`, `"7+"` or a number) and,
since 0.33.0, `revision`, which names all its lines as the last page of
notes.transcript's `revision` does; absent from an older host.

**`ChatSettingsSchema`**

What a chat runs with, and what it may be set to.

**`ChatSettingsSchema.model`**

The model it runs, by the id to give back; null before the program says.

**`ChatSettingsSchema.options.efforts`**

The effort levels its model takes; none when it takes none.

**`ChatSettingsSchema.options.modes`**

The permission modes; `dangerous` ones ask the serving device's policy first.

**`ChatCommandSchema`**

A slash command of a chat, for a "/" picker: the app's own (run with
chat.command), the agent's own (sent as a message: chat.send "/name
args"), or one that sets what chat.configure sets.

**`ChatCommandSchema.runs`**

command: chat.command; send: chat.send its text; settings: chat.configure.

**`ChatCommandSchema.sets`**

With runs "settings": what it sets, so the picker for it opens.

**`ChatCommandSchema.args`**

What it takes after its name, as its help writes it ("<condition>").

**`ChatCommandSchema.aliases`**

Other names it is typed by ("bg" for "background"). Since 0.13.0.

**`ConfigValueSchema`**

A value of a Claude Code setting (/config): on or off, a choice, or text.

**`ChatConfigSchema`**

A Claude chat's Claude Code settings (/config), as its settings dialog
shows them: each key in the dialog's order, its group, what it takes and
what it is now (none when no setting says); the models the model takes
and the output styles; the model the session runs; and the default
effort the settings give each model (`efforts`, by its id; `level` the
one for any), none when that program cannot save one. A Codex chat's
defaults (its /config): `model`, `efforts.level`, and settings supported by
the host. Numeric settings use text with decimal string values. Empty
`options` means read-only. With no `value`, an override can still exist
outside the client's range if `valueUnavailable` is true. The reserved
`_codex_profile_id` key binds the read to its profile and is not a UI control.
Since 0.13.0.

**`PastSessionSchema`**

A chat of the past that can be resumed: Claude Code's sessions, Codex's threads.

**`PastSessionSchema.at`**

When it last changed, in Unix milliseconds.

**`PastSessionSchema.bytes`**

Its log's size in bytes, when known.

**`PastSessionSchema.cwd`**

The folder it ran in.

**`PastSessionSchema.firstPrompt`**

Its first prompt, when its title is not. Since 0.11.0.

**`PastSessionSchema.gitBranch`**

The git branch it ran on. Since 0.11.0.

**`PastSessionSchema.tabId`**

The tab it is open in now, there; chat.resume shows that one. Since 0.11.0.

**`GitLetter`**

A file's state in git: a letter as `git status --porcelain` gives it (M, A, D, R, C, U, ?).

**`GitFileSchema`**

A file git sees changed, staged or not.

**`GitFileSchema.oldPath`**

Renamed or copied from.

**`DiffHunkSchema`**

A piece of a diff, as jsdiff's structuredPatch gives it: lines starting " ", "-" or "+".

**`MAX_LIST_ENTRIES`**

Most entries one files.list gives.

**`MAX_READ_BYTES`**

Most bytes of text one files.read gives.

**`MAX_BYTES_CHUNK`**

Most bytes one files.read `as: "bytes"` gives: a piece of a file, base64 inside a frame.

**`FileVersionSchema`**

An opaque files.read source generation, scoped to the workspace and path.

**`MAX_FIND_RESULTS`**

Most paths one files.find gives.

**`MAX_FILE_SUGGESTIONS`**

Most paths one chat.fileSuggestions gives.

**`MAX_SEARCH_MATCHES`**

Most matches one files.search gives, all files together.

**`CommitHashSchema`**

A commit by its hash, whole or a prefix of it: hex only, so nothing else is taken for one.

#### Chats

**`MAX_READ_ITEMS`**

Most items one chat.read gives; earlier ones come by `before`.

**`ChatPageSchema`**

A page of a chat: its status, the items from `start` (before `total`),
and the tool calls, tasks and subagents' messages they name.

**`ChatAppendSchema`**

Text added to the end of a block (text or thinking) of the assistant
item at `index`: sent for a watch that asked for appends, in place of
the whole item, while a reply streams in.

**`ChatAppendSchema.text`**

What follows the block's text, in UTF-16 code units: it may start inside a surrogate pair.

**`ChatStreamAppendSchema`**

Text added to the end of a block of the reply being written (the
status's streaming message): a text, thinking or tool_use block, whose
text for a tool is its input's JSON so far.

**`ChatStreamAppendSchema.text`**

What follows the block's text, in UTF-16 code units: it may start inside a surrogate pair.

**`ChatUpdateStatusSchema`**

A chat.update's status: as a page's, but for a watch that asked for
appends its `streaming` may be left out, when the watcher's own stays
(with the update's streamAppends added).

**`ChatUpdateSchema`**

What changed in a watched chat since its last update (or its watch
began), applied in this order:
- `items` are put at their index; `total` cuts the list when it got
  shorter.
- Each of `appends` adds its text to an assistant item's block. One
  before the watcher's page is dropped; one to an item that is not an
  assistant's, or to a block it does not have or that holds no text,
  means the watcher missed something, and watches again.
- `status` replaces the watcher's, keeping the watcher's streaming
  message when it has no `streaming`.
- Each of `streamAppends` adds its text to a block of that streaming
  message; one with no streaming message, or no such block, means the
  watcher missed something, and watches again.
Tool calls, tasks and subagents' messages are put by id.

**`ChatUpdateSchema.rev`**

Counts the watch's updates from 1, so one lost shows.

**`ChatUpdateSchema.appends`**

Only for a watch that asked for them (chat.watch's `appends`), as streamAppends.

**`ChatUpdateSchema.panel`**

The side panel, when it changed.

#### A chat's last turns, at a glance (chat.peek; since 0.27.0)

**`DEFAULT_PEEK_TURNS`**

Turns a chat.peek gives when it names none.

**`MAX_PEEK_TURNS`**

Most turns a chat.peek asks for.

**`MAX_PEEK_BYTES`**

Most bytes a chat.peek answer takes: its result, encoded as JSON, in
UTF-8. The serving device fits the answer in this (see ChatPeekSchema).

**`MAX_PEEK_USER_TEXT`**

Most characters (code points) of the user's message in a peeked turn.

**`MAX_PEEK_REPLY`**

Most characters of the agent's last words in a peeked turn.

**`MAX_PEEK_RECEIVED_TEXT`**

Most characters of another sender's message in a peeked turn.

**`MAX_PEEK_SENDER`**

Most characters of the name of another sender in a peeked turn, as AgentSender's `name`.

**`MAX_PEEK_STREAMING`**

Most characters of the reply being written that a peek carries.

**`MAX_PEEK_TOOLS`**

Most tool names a peeked turn counts; the rest add up in `otherTools`.

**`MAX_PEEK_TOOL_NAME`**

Most characters of a tool's name in a peeked turn.

**`codePointText`**

A string of at most `max` characters, counted as code points: a
character outside the Basic Multilingual Plane (an emoji) counts one,
though it takes two UTF-16 units.

**`ChatPeekTurnSchema`**

One turn of a peeked chat: what began it, the agent's last words in it,
and the tools it called, counted. What came before the first message
read (a turn cut at the start of what was read) has neither `user` nor
`received`; a turn has at most one of them.

**`ChatPeekTurnSchema.user`**

The user's message that began the turn: its text (cut at
MAX_PEEK_USER_TEXT), how many images it had, and how many other files
(left out when none).

**`ChatPeekTurnSchema.received`**

Another sender's message that began the turn (nexus chat send): the
sender as the chat names it (its tab's title, else its agent or kind),
cut at MAX_PEEK_SENDER, and its text, cut at MAX_PEEK_RECEIVED_TEXT.

**`ChatPeekTurnSchema.reply`**

The agent's last words in the turn: the text blocks of its last message
in the turn that has text, joined by a blank line, cut at
MAX_PEEK_REPLY. No thinking, no tool input or result. Empty when it
wrote none.

**`ChatPeekTurnSchema.tools`**

The tool calls the agent made in the turn (not its subagents'), counted
by the tool's name as its program names it ("Bash", "mcp__srv__tool"):
the MAX_PEEK_TOOLS most called, a tie going to the one called first. A
name longer than MAX_PEEK_TOOL_NAME is cut, and names cut alike count
together.

**`ChatPeekTurnSchema.otherTools`**

The calls of the tools `tools` leaves out, added up; left out when none.

**`ChatPeekSchema`**

A chat's last turns at a glance, for a preview (chat.peek). The serving
device reads them from the chat's history as it is kept, and so:
- does not open the tab, start or resume its program, or connect to a
  workspace's host (SSH, WSL) for it;
- does not wait for subagents, and sends no tool results;
- marks nothing seen.

Its size: the result, encoded as JSON, is at most MAX_PEEK_BYTES in
UTF-8. Each text is first cut at its own limit; then, while the answer is
over, the oldest turn is left out (and `more` set), down to one; then the
texts are cut shorter, in this order, each as far as needed (to nothing
but "…" when it must): the turns' `reply`, `user.text`,
`status.streaming`, `received.text`. The limits are the most each may
take within the budget, not what each may always take: a text in Korean,
three bytes a character, at all its limits is over it.

Cutting: by code points, never inside one. A text cut at its start keeps
it and ends with "…" (U+2026); `status.streaming`, cut at its end, keeps
its end and begins with "…". The "…" counts in the limit. Texts are sent
as written otherwise (no trimming beyond the cut). fitPeek does all this,
and peekTools counts a turn's tools.

**`ChatPeekSchema.status.running`**

A turn is under way. Only a tab open there runs one.

**`ChatPeekSchema.status.phase`**

Where its tab stands with its program, as ChatStatus's `phase` (idle before it opens).

**`ChatPeekSchema.status.streaming`**

The reply being written, while a turn runs: its text blocks so far,
joined by a blank line, the last MAX_PEEK_STREAMING characters ("…"
before them when cut). Left out when it has none.

**`ChatPeekSchema.more`**

There are turns before those sent: older, or left out to fit the budget.

**`ChatPeekSchema.turns`**

The last turns, oldest first, at most the turns asked for.

**`ChatPeekSchema.waiting`**

What the chat waits on the user for now: a permission (with the tool
that asks, as `tools` names it), a question, or a plan to approve. Only
from a tab open there; one this version cannot read is left out.

**`ChatPeekSchema.unavailable`**

Why no turns could be read, with `turns` empty:
- offline: the workspace is on a host (SSH, WSL) the device is not
  connected to now; a peek does not connect to it.
- missing: the chat has no history to read (it never ran, or its
  record is gone).
A tab that is not there is a NotFound error, as for chat.read.

**`TerminalCaretSchema`**

Where a terminal's cursor is in its text (terminal.read and
terminal.watch with `ansi`; since 0.13.0): on its `line`th line from 0,
after `column` characters of it (code points, escapes not counted). Past
the line's end each blank cell counts one, and past the text's last line
the lines are blank, the text leaving out the blank lines at its end.
There is none while the program hides the cursor (as one that draws its
own does), or when it is above the lines sent.

**`TerminalUpdateSchema`**

A watched terminal's text changed: the text from `start` (a UTF-16
offset into the text as it was) is now `text`. A redraw at the bottom
sends only the bottom; a scroll, all of it from 0. A watch with `ansi`
counts in the text with its escapes, and tells where the cursor is now
(`caret`, none while hidden; since 0.13.0), the text unchanged
(`start` at its end, `text` empty) when only the cursor moved.

**`TerminalUpdateSchema.rev`**

Counts the watch's updates from 1, so one lost shows.

**`SessionsUpdateSchema`**

The sessions' list as it is now, sent whenever it changes during a sessions.watch.

**`MAX_FILE_WRITE_BYTES`**

Maximum size negotiated at the start of a file transfer.

**`FileScope.anywhere`**

An absolute path on the serving device, with terminal control. Since 0.14.0.

**`FileTransferRef.transferId`**

Keep a one-time approval within the paths used by this copy.

#### The methods

**`VoiceSuggestionTarget`**

Each method's params and result, and the capability (see ./sealed.ts)
the serving device lists for it.

**`MAX_MARK_SEEN`**

Most sessions one sessions.markSeen request can name.

**`RPC_METHODS."sessions.watch"`**

The list now; then a sessions.update each time it changes, until sessions.unwatch.

**`RPC_METHODS."sessions.reorder"`**

Reorders the named slots in a workspace's agent list, as the user. Since 0.21.0.

**`RPC_METHODS."sessions.markSeen"`**

For the user only. Marks currently unread results whose since is at most upTo,
using the host's listing time. Returns the number marked. Since 0.23.0.

**`RPC_METHODS."events.read"`**

The session state changes after `since` (the first `limit`, `more` when
some were left out), or the last `limit`; `cursor` is the latest seq. A
`since` past it (from before the app restarted) reads from the start.

**`RPC_METHODS."events.read".result.events`**

Since 0.12.1, an event this version cannot read (a kind it does not know) is left out.

**`RPC_METHODS."profiles.list"`**

The agent profiles a chat can run with (accounts, config folders).

**`RPC_METHODS."profiles.list".result.profiles.isDefault`**

The one a workspace runs with unless told otherwise.

**`RPC_METHODS."profiles.usage"`**

Subscription limits last observed for the profiles on a workspace host.
Before 0.30.0 only an agent's request (`from`) is taken; a device that
lists `profiles.usage.people` takes people's too. The answer names each
profile by its id and the name the user gave it, never by an account's
email or keys.

**`RPC_METHODS."profiles.usage".result.profiles.fetchedAt`**

When the serving app last received limits, in Unix milliseconds.

**`RPC_METHODS."folders.list"`**

The folders in one of the device's folders, to pick one to add as a
workspace: only folders (and links to them), no files; hidden ones
(a leading dot, or Windows' hidden attribute) only with `hidden`. By
name, case aside, at most MAX_FOLDERS (`truncated` past that). With no
`path`, the home folder; a relative one is InvalidParams. NotFound for
a path that is no folder; Forbidden ("permission denied") for one it
may not read. Since 0.12.0.

**`RPC_METHODS."folders.list".result.path`**

The folder listed, as the device writes it.

**`RPC_METHODS."folders.list".result.parent`**

The folder it is in; none at a root.

**`RPC_METHODS."folders.list".result.roots`**

Windows: its drives' roots ("C:\\").

**`RPC_METHODS."workspace.create"`**

Adds one of the device's folders as a workspace, at the sidebar's end
(not pinned), named `name` or as the folder is. A workspace of that
folder already there is given back, `created` false. NotFound for a
path that is no folder. Since 0.12.0.

**`RPC_METHODS."history.list"`**

The past chats of a workspace's folder that can be resumed, latest first.

**`RPC_METHODS."history.list".params.query`**

Only those whose title has it.

**`RPC_METHODS."chat.read"`**

The chat's last `limit` items, or those before `before`.

**`RPC_METHODS."chat.peek"`**

The chat's last `turns` turns (DEFAULT_PEEK_TURNS when it names none)
at a glance, within MAX_PEEK_BYTES, read without starting anything
(ChatPeekSchema). For a preview: a device asks it of one whose hello
serves chat.peek, and chat.read of one that does not. A device serves
it only where it serves chat.read. Since 0.27.0.

**`RPC_METHODS."chat.watch"`**

The chat's last page now; then a chat.update each time it changes, until chat.unwatch.

**`RPC_METHODS."chat.watch".params.appends`**

The watcher takes text added to an assistant item's block, and to
the reply being written, as `appends` and `streamAppends` in its
chat.update; without it, the whole item or status comes.

**`RPC_METHODS."chat.settings"`**

What the chat runs with and may be set to (model, effort, permission mode).

**`RPC_METHODS."chat.commands"`**

Its slash commands, the app's and the agent's, for a "/" picker.

**`RPC_METHODS."chat.panel"`**

Its side panel now; a watch sends it again in chat.update as it changes.

**`RPC_METHODS."chat.tool"`**

One tool call with as much of its result as a frame takes.

**`RPC_METHODS."chat.tool".params.runId`**

One of the chat's runs (chat.runs): the call is looked for in that run's
own session, as chat.runRead reads it, not in the conversation. NotFound
for a run that is not one of that chat's; for a run with no session to
read, as chat.runRead. Since 0.30.0; send it only to a device whose hello
says RUN_ITEMS_SCHEMA or later, as an older one drops it and looks in the
conversation.

**`RPC_METHODS."chat.original"`**

A file the chat changed as it was before its first change, for its
diff (`path` as its changes name it): null for one it wrote new.
NotFound when it is not kept (the change did not report it, or the
file is not one the chat changed); Unavailable when too large to send.
Since 0.13.0.

**`RPC_METHODS."chat.wait"`**

Waits up to `timeoutMs` (at most MAX_WAIT_MS) for the chat to be done
with its turn: no longer working (asking, idle, error, or closed). Ask
again while `done` is false. `after`: a chat.send's `at`, so a message
the chat has not shown yet counts as working.

**`RPC_METHODS."chat.wait".result.message`**

Its last answer; when asking, what it asks; on an error, what went wrong.

**`RPC_METHODS."chat.image"`**

An image of the chat, made small enough for a frame: a user message's
(by its item's key and the image's index), a tool result's, or (since
0.13.0) a message's held for after the turn (panel.held, by its id). With
`maxEdge`, drawn smaller (as a JPEG) till its longer side is at most
that many pixels, for a thumbnail; one already that small goes as it is.

**`RPC_METHODS."chat.image".params.runId`**

One of the chat's runs (chat.runs): the image is looked for in that run's
own session, by the item keys and tool call ids a chat.runRead page gives.
A `held` ref is never found there. Since 0.30.0, as chat.tool's `runId`.

**`RPC_METHODS."chat.image".params.maxEdge`**

Since 0.9.0; a desktop before it sends the image whole.

**`RPC_METHODS."chat.image".params.versioned`**

Opt in to validating the requested image before sending its bytes.

**`RPC_METHODS."chat.image".result.data`**

Base64, empty when the currently authorized image matches ifVersion.

**`RPC_METHODS."chat.image".result.width`**

In pixels: always, from 0.9.0; before, only when it was drawn smaller.

**`RPC_METHODS."chat.send"`**

Sends a message, as its composer does. `text` may be empty only with
attachments. Sent by an agent (`from`), the chat shows it as that
agent's, not the user's.

During a turn, `when` (since 0.12.0) is as its composer's keys:
- next (↩, the default): a Claude chat reads it after the tool it
  runs, the message shown unread (UserItem.queued) until then, which
  chat.withdraw takes back; a Codex chat takes it into the turn.
- now (⌘↩): a Claude chat's running tools go to the background, or the
  turn stops, and it reads the message at once (panel.can.now). A
  Codex chat takes it as next.
- after (⌘⇧↩): the serving device holds it (panel.held, `heldId`)
  until the turn ends, then sends it, one a turn in the order they
  came. chat.unqueue and chat.editHeld change it until then.
With no turn running, each sends it at once.

**`RPC_METHODS."chat.send".params.attachments`**

Images chat.attach took and files chat.upload took, at most MAX_ATTACHMENTS.

**`RPC_METHODS."chat.send".result`**

`at`: when the serving device took it, by its clock, for chat.wait's
`after`. `heldId`: the held message's id, when `after` held it.

**`RPC_METHODS."chat.fileSuggestions"`**

What an @ in the chat's composer may name for `query`, as its agent
suggests it for its own composer: paths relative to the chat's folder,
or absolute, with the separators of its computer; a folder's ends in
one. At most MAX_FILE_SUGGESTIONS; none while its program does not
run. Since 0.13.0.

**`RPC_METHODS."chat.unqueue"`**

Takes back a message held for after the turn (panel.held), with its
whole text for the asking device's composer. NotFound once it went.
Since 0.12.0.

**`RPC_METHODS."chat.editHeld"`**

Changes the text of a message held for after the turn, its attachments
kept. NotFound once it went; InvalidParams for an empty text with no
attachments. Since 0.12.0.

**`RPC_METHODS."chat.withdraw"`**

Takes back one of the user's messages a Claude chat has not read yet
(UserItem.queued), by its item's key: `withdrawn` false once it was
read. panel.can.withdraw says whether the chat's program can. Since 0.12.0.

**`RPC_METHODS."chat.hurry"`**

Has a Claude chat read its unread messages now, as ⌘↩ on an empty
composer: its running tools go to the background, or the turn stops.
Nothing unread: nothing done. Since 0.12.0.

**`RPC_METHODS."chat.attach"`**

Takes an image for the next chat.send to this tab: one image a request,
small enough for a frame. Kept 10 minutes, for this device only.

**`RPC_METHODS."chat.attach".params.data`**

Base64, of at most MAX_ATTACHMENT_BYTES bytes.

**`RPC_METHODS."chat.upload.begin"`**

Starts sending a file for the next chat.send to this tab, any file of
at most MAX_UPLOAD_BYTES, a chunk a request (chat.upload.chunk), then
chat.upload.end. Since 0.10.0. The upload is for this device only, and
dropped when it goes 10 minutes without a chunk or a chunk is refused.

**`RPC_METHODS."chat.upload.begin".params.name`**

The file's name, without a folder: what the agent is told it was.

**`RPC_METHODS."chat.upload.begin".params.size`**

Its bytes, all of them.

**`RPC_METHODS."chat.upload.begin".params.mediaType`**

Its type when known; an image the chat takes goes as an image.

**`RPC_METHODS."chat.upload.chunk"`**

The next piece of an upload, from `offset`, the bytes sent so far. Since 0.10.0.

**`RPC_METHODS."chat.upload.chunk".params.data`**

Base64, of at most MAX_BYTES_CHUNK bytes.

**`RPC_METHODS."chat.upload.end"`**

Ends an upload whose bytes all came: its id for chat.send's attachments,
kept 10 minutes as chat.attach's. Since 0.10.0. A PNG, JPEG, GIF or WebP
small enough goes to the chat as an image; any other file as a dropped
file does on the desktop, its path after the message's text.

**`RPC_METHODS."chat.answer"`**

Answers the permission request `requestId`, as its card's buttons do.

**`RPC_METHODS."chat.answer".params.message`**

Why, for a denial: the program reads it.

**`RPC_METHODS."chat.answer".params.updatedInput`**

With allow: the input the tool runs with, as the user filled it (a
question's answers). Refused from an agent (`from`): the user is
asked about the request as it came.

**`RPC_METHODS."chat.answer".params.stop`**

With deny: the turn stops too, as the card's "No, and stop" does.

**`RPC_METHODS."chat.answer".params.always`**

With allow: the request's suggestions to keep from now on, by index
("always allow"). Refused from an agent (`from`), as allowAlways is.

**`RPC_METHODS."chat.answer".params.planMode`**

With allow of a plan (ExitPlanMode): the permission mode the chat
goes on in, as the plan card's approvals set it (edits allowed, or
each asked). Refused from an agent (`from`), as `always` is. Since
0.13.0.

**`RPC_METHODS."chat.restart"`**

Starts a chat's program again, as its banner there does: going on with
the session once it ended (`phase` ended), or opening it again where it
failed or its session was not found; and one that runs (`phase` ready)
again on its session, as the card after /login or /update offers, a
turn under way stopping. Only the user's: an agent does not send it.
Since 0.13.0.

**`RPC_METHODS."chat.checkSignIn"`**

Asks a Codex chat's program again whether it is signed in, as its
signed-out banner's "check again" does once the user signed in there
(status `signedOut`); whether it still is not. Only the user's: an
agent does not send it. Since 0.13.0.

**`RPC_METHODS."chat.configure"`**

Sets any of model, effort and permission mode, as the composer's chips
do; what it runs with after. A mode the serving device's policy does
not allow is refused (Forbidden) with why.

**`RPC_METHODS."chat.profile"`**

Has a Claude or Codex chat run with another of its agent's profiles
(profiles.list, by id or name), as its profile chip does: its
conversation goes on there, or, `fresh`, a new one starts there. The
profiles' names, the one it ran with and the one it runs with now.
Refused (Unavailable) while it works or waits on the user, unless
`stop` (since 0.13.0, when its panel's `can.moveNow`): its turn stops
then, as its chip there does. Refused too when it runs with that
profile already; a profile its agent does not have is InvalidParams.
An agent may send it (with `from`): the serving device's agent policy
applies as for other chat writes, so under `allow` nothing is asked,
under `ask` the user is asked, and under `deny` it is refused
(Forbidden). The session's `profile`
(sessions.list, sessions.watch) follows. From 0.10.0.

**`RPC_METHODS."chat.config"`**

A Claude chat's Claude Code settings (/config), as its settings dialog
there has them: without `set`, what they are now (`config`); with it,
the changes saved as that dialog saves them (/config messages), and a
new default effort for the model the session then runs. Not while the
chat is working. For Codex, `changes` holds the advertised config keys and
`effort` holds the reasoning effort. An empty numeric string or a
resettable choice's advertised `default` removes its override.
Echo the value of a read's reserved
`_codex_profile_id` in `changes` when present. Model and effort also apply to the
tab's next turn. Only the user's: an agent does not send it. Since 0.13.0.

**`RPC_METHODS."chat.mcp"`**

Works one of a Claude chat's MCP servers as its panel there does (its
panel's `can.mcp`): connects it again, or turns it on or off. A
sign-in is the asking device's, its browser's: `signIn` with the
address its sign-in page comes back to on that device (a loopback
one) gives the page to open (`authUrl`; none when signed in already,
connected again then), and when the page comes back there (`back`),
`signedIn` with the address it came back to finishes it. Only the
user's: an agent does not send it. Since 0.13.0.

**`RPC_METHODS."chat.mcp".params.redirectUri`**

`signIn`'s: where the sign-in page comes back to on the asking device.

**`RPC_METHODS."chat.mcp".params.callbackUrl`**

`signedIn`'s: the address the page came back to there.

**`RPC_METHODS."chat.command"`**

Runs one of the app's slash commands (chat.commands' `command` ones), `args` after its name.

**`RPC_METHODS."chat.command".result.message`**

What it said, when it says something rather than changing the chat.

**`RPC_METHODS."chat.command".result.card`**

The message is what its card says, which its tab shows over the
composer; false, what a toast says. Since 0.13.0.

**`RPC_METHODS."chat.command".result.tabId`**

The tab it opened, when it opened one.

**`RPC_METHODS."chat.stopTask"`**

Stops a task of the chat's (a background run, a subagent), as the side panel's button does.

**`RPC_METHODS."chat.runs"`**

The `claude -p` and `codex exec` runs the chat's session started, as
its chat shows them among its agents: running ones, then those that
ended, latest first, at most MAX_CHAT_RUNS. Since 0.13.0.

**`RPC_METHODS."chat.run"`**

One of the chat's runs, with its tools, messages and answer; NotFound once it is not kept. Since 0.13.0.

**`RPC_METHODS."chat.runRead"`**

One of the chat's runs as the conversation its own session holds, a
page as chat.read gives one of the chat: the run's last `limit` items,
or those before `before`. Only a run of that chat's; NotFound for any
other, and for a run that keeps no session to read (chat.run still
tells what it told the app). Since 0.28.0.

**`RPC_METHODS."chat.stopRun"`**

Stops one of the chat's running runs, as its pane's stop button does:
`stopped` false when it no longer could be. Since 0.13.0.

**`RPC_METHODS."chat.resume"`**

Opens a past chat (history.list) in a new tab, or the tab it is open
in. With `tabId`, a chat of the agent's, it goes on in that tab
instead, as the desktop's /resume and a new tab's list of past sessions
do; not while a turn runs (since 0.11.0; before, `tabId` is not known
and a new tab opens).

**`RPC_METHODS."chat.rewindPreview"`**

What rewinding a Claude chat to before one of the user's messages (by
its item's key) would undo in the files: those the turns since changed,
and how many lines. `canRewind` false (with why) when the files cannot
be rewound; the conversation still can. Since 0.11.0.

**`RPC_METHODS."chat.rewind"`**

Rewinds a Claude chat to before one of the user's messages, by its
item's key: the conversation, and with `files` the files the turns
since changed. The message is the asking device's to put back in its
composer; the serving device's stays as it was. Since 0.11.0.

**`RPC_METHODS."chat.fork"`**

Forks a Claude chat into a new tab there, behind what that device
shows: from one of the user's messages, the conversation before it,
and the message as `draft` for the asking device's composer; from an
answer, the conversation up to it; with no item, all of it. Since 0.11.0.

**`RPC_METHODS."chat.background"`**

Sends a Claude chat's running command or subagent to the background, by its call's id. Since 0.11.0.

**`RPC_METHODS."chat.remoteControl"`**

Turns a Claude chat's Remote Control on or off, as its panel's switch does. Since 0.11.0.

**`RPC_METHODS."chat.new"`**

Opens a chat in one of the serving device's workspaces, sending it
`prompt` if given. `model` and `effort` are set before the prompt goes,
named as the agent's own menus name them ("haiku", "low"); the tab's
profile's own otherwise.

**`RPC_METHODS."chat.new".params.profile`**

The agent profile, by id or name (profiles.list); the workspace's otherwise.

**`RPC_METHODS."chat.new".params.folder`**

A folder inside the workspace to run in; its own folder otherwise.

**`RPC_METHODS."chat.new".params.from`**

Sent by an agent: the chat shows the prompt as that agent's.

**`RPC_METHODS."chat.new".result.error`**

The tab opened, but the model or effort could not be set: the prompt was not sent.

**`RPC_METHODS."terminal.read"`**

A terminal's screen and the lines above it, as text; with `ansi`, with
its colors and styles as SGR escapes (no other escapes), and where its
cursor is (`caret`, TerminalCaretSchema; since 0.13.0).

**`RPC_METHODS."terminal.watch"`**

The terminal's text now, as terminal.read; then a terminal.update each time it changes, until terminal.unwatch.

**`RPC_METHODS."terminal.input"`**

Types into a terminal: `text` as pasted, then `keys` by name
(TERMINAL_KEYS), then Enter when `enter`. With `typed` (since 0.13.0),
the text goes in as keystrokes, as the user typed it, not as a paste:
a program that turned on bracketed paste takes a paste as text, where
typed keys are its commands (vim's j, a menu's choice). Sent by an
agent (`from`), the receiving device counts it as that agent's.

**`RPC_METHODS."terminal.input".result`**

`at`: when it was typed, by the serving device's clock, for terminal.wait's `after`.

**`RPC_METHODS."terminal.wait"`**

Waits up to `timeoutMs` (at most MAX_WAIT_MS) as `nexus terminal wait`
does: for the terminal's agent to finish its turn, its shell to be back
at the prompt, or quiet output; with `exit`, for its program to end;
with `match`, for a line to match. Ask again while `done` is false.

**`RPC_METHODS."terminal.wait".params.after`**

A terminal.input's `at`: a turn must have started after it.

**`RPC_METHODS."terminal.wait".params.quietMs`**

Quiet for this long counts as idle, for a program that is no agent or shell.

**`RPC_METHODS."terminal.wait".result.state`**

idle, completed, needsInput, permissionPending, error, notStarted, notified, exited, matched, or waiting.

**`RPC_METHODS."terminal.answer"`**

Answers the permission request a terminal's Claude Code holds for the
app (its session's `waiting.requestId`), as the agent list's buttons do.
An answer for agents, so chat.control's: no typing goes in.

**`RPC_METHODS."terminal.shells"`**

The shells a new terminal can run, as "New terminal with" lists them.

**`RPC_METHODS."terminal.open"`**

Opens a terminal: a shell (by its id), in a folder inside the workspace,
running `command`. With `profile` (profiles.list's id, or a name only
one profile has) its shell runs with what a chat of that profile runs
with: the profile's folder (CODEX_HOME, CLAUDE_CONFIG_DIR) and its own
variables. A profile that computer has not is InvalidParams: the
terminal never opens with the default folder in its place. Since 0.13.1.

**`RPC_METHODS."terminal.close"`**

Closes a terminal; one running a program only with `force`.

**`RPC_METHODS."consent.answer"`**

Answers a consent prompt of sessions.list's `consents`, as the user would
on the serving device, where it closes. NotFound when it is no longer
waiting (answered there, or timed out); Forbidden when it is not
`answerable`, or for "session" to one asked about each time. An
agent's request (`from`) is refused: only people answer these.

**`RPC_METHODS."files.list"`**

A folder's entries, folders first. `path` is absolute or inside the
workspace's folder ("" for it); it must be in the workspace's folders
(its own, and those its chats were given).

**`RPC_METHODS."files.list".params.writeTarget`**

Recursive push checks its destination without listing its contents.

**`RPC_METHODS."files.list".result.path`**

The folder, absolute.

**`RPC_METHODS."files.list".result.truncated`**

More than MAX_LIST_ENTRIES: the rest left out.

**`RPC_METHODS."files.read"`**

A file: text (its start, up to `maxBytes`), an image made small enough
for a frame, or that it is binary. With `as: "bytes"`, a piece of it as
it is, whatever it holds: `length` bytes (at most MAX_BYTES_CHUNK, which
is the default) from `offset`, for a viewer that needs the whole file
(a PDF, a document) to take it piece by piece.

Since 0.13.4, an opting-in reader can validate a cached representation
of the same authorized source or pin another piece to its version.
A host may return fresh bytes without a version.

**`RPC_METHODS."files.read".params.length`**

Zero is a metadata-only bytes read and requires version opt-in.

**`RPC_METHODS."files.read".params.versioned`**

Ask for a version if the host can validate this file.

**`RPC_METHODS."files.read".params.ifVersion`**

Return notModified when this version still names the authorized file.

**`RPC_METHODS."files.read".params.requireVersion`**

Pin a bytes piece to this generation; mutually exclusive with ifVersion.

**`RPC_METHODS."files.read".result.data`**

Base64; fewer bytes than asked at the end of the file, none past it.

**`RPC_METHODS."files.read".result.size`**

The whole file's.

**`RPC_METHODS."files.write.begin"`**

Begin writing to a final file path whose parent already exists. Since 0.14.0.

**`RPC_METHODS."files.write.chunk"`**

One positioned piece. An upload retains the permission from its begin request.

**`RPC_METHODS."files.write.end"`**

Verify the entire file and place it at its destination.

**`RPC_METHODS."files.write.abort"`**

Cancel a pending upload and remove its temporary file.

**`RPC_METHODS."files.mkdir"`**

Make one directory. Succeeds if it is already a directory. Since 0.14.0.

**`RPC_METHODS."files.find"`**

Files by name, as quick open finds them: `query`'s characters in order
in the path (case and spaces not minded), the best matches first (in
the file name, at word starts, together). Every file under the
workspace's folder but those in the folders the search panel leaves out
(.git, node_modules, dist, out, build and the like). Paths are relative
to the workspace's folder with "/" between their parts, on Windows too,
as files.read takes them.

**`RPC_METHODS."files.find".params.limit`**

At most MAX_FIND_RESULTS; 50 when not said.

**`RPC_METHODS."files.find".result.truncated`**

The workspace has more files than were looked through: some may be missing.

**`RPC_METHODS."files.search"`**

Text in the workspace's files, as the search panel finds it, with the
same engine (so in an SSH or WSL workspace too) and the same files.
`include` and `exclude` take an extension ("*.ts"), a folder's name
("fixtures/") or a file's whole name. Paths are relative to the
workspace's folder with "/" between their parts, on Windows too, as
files.read takes them.

**`RPC_METHODS."files.search".params.limit`**

Matches, at most MAX_SEARCH_MATCHES; 200 when not said.

**`RPC_METHODS."files.search".result.files.matches.line`**

From 1.

**`RPC_METHODS."files.search".result.files.matches.column`**

From 0, in UTF-16 units of the whole line.

**`RPC_METHODS."files.search".result.files.matches.length`**

In UTF-16 units.

**`RPC_METHODS."files.search".result.files.matches.text`**

The line; a long one cut to a window around the match.

**`RPC_METHODS."files.search".result.files.matches.textStart`**

Where `text` begins in the line when it was cut (UTF-16 units); 0 when absent.

**`RPC_METHODS."files.search".result.truncated`**

More matches than `limit` or a frame takes: the rest left out.

**`RPC_METHODS."system.stats"`**

How busy the workspace's host is, as its status bar shows it: the share
of the CPU in use and the memory. An SSH or WSL workspace's host is
asked while it is connected. NotFound for a workspace that is not there;
Unavailable while its host cannot tell. Only the user's: an agent's
request (`from`) is refused. Since 0.26.0.

**`RPC_METHODS."system.stats".result.cpu`**

The share of the CPU time in use, 0 to 100; null when it cannot be told.

**`RPC_METHODS."system.stats".result.memUsed`**

Bytes the programs hold, as the machine's own monitor counts them.

**`RPC_METHODS."system.stats".result.memTotal`**

All the memory there is, in bytes.

**`RPC_METHODS."git.status"`**

The workspace's branch, how it stands against its upstream, and its changed files.

**`RPC_METHODS."git.status".result.branch`**

null when no branch is checked out.

**`RPC_METHODS."git.status".result.topLevel`**

Absolute root from git rev-parse --show-toplevel, with slashes on Windows. Since 0.24.0.

**`RPC_METHODS."git.status".result.truncated`**

More files than a frame takes: the rest left out.

**`RPC_METHODS."git.diff"`**

A file's changes, staged or not, in hunks as an edit's patch has them.
With `commit`, its change in that commit against the commit's first
parent (against nothing for a root commit), by the path git.show lists
it at; `staged` is not taken with it.

**`RPC_METHODS."git.diff".result.truncated`**

More than a frame takes: the hunks after left out.

**`RPC_METHODS."git.log"`**

The branch's commits, latest first.

**`RPC_METHODS."git.log".result.commits.at`**

When it was written (git's author date, which a rebase keeps), Unix milliseconds.

**`RPC_METHODS."git.show"`**

A commit: who made it and when, its message, and the files it changed
against its first parent, as the commit tab shows them. Paths are the
repository's, relative to its top level, as git.status gives them.

**`RPC_METHODS."git.show".result.hash`**

The whole hash.

**`RPC_METHODS."git.show".result.body`**

The message after its subject line; absent when there is none.

**`RPC_METHODS."git.show".result.at`**

When it was written, as git.log tells it (git's author date), Unix milliseconds.

**`RPC_METHODS."git.show".result.files.oldPath`**

A renamed or copied file's path before.

**`RPC_METHODS."git.show".result.files.status`**

git's letter: A, M, D, R, C or T.

**`RPC_METHODS."git.show".result.truncated`**

More files than a frame takes: the rest left out.

**`RPC_METHODS."notes.list"`**

A workspace's notes, the last changed first, at most MAX_LISTED_NOTES:
where notes.attach may put a photo.

**`RPC_METHODS."notes.list".result.notes.title`**

Empty for a note not named yet.

**`RPC_METHODS."notes.list".result.notes.updatedAt`**

When it last changed, Unix milliseconds.

**`RPC_METHODS."notes.list".result.notes.recordings`**

How many recordings the note has, 0 for none. Since 0.31.0; absent from
an older host.

**`RPC_METHODS."notes.read"`**

A note, found by id, id prefix or title, as Markdown, with what was said
in its recordings as Markdown in `transcript` (empty for a note without
recordings). The answer must fit in a frame: otherwise Unavailable. Read a
note with a long transcript with `withoutTranscript` and its recordings
with notes.transcript a page at a time, and a long body with
`markdownStart` and `markdownLimit`. Answer:
`{ id, title, updatedAt, markdown, markdownStart, markdownTotal, transcript, recordings }`.

**`RPC_METHODS."notes.read".params.transcriptOnly`**

Only the transcript: `markdown` is empty.

**`RPC_METHODS."notes.read".params.withoutTranscript`**

Only the body: `transcript` is empty, and `recordings` tells each
recording's id and size for notes.transcript. Not with `transcriptOnly`
(InvalidParams). Since 0.31.0; send it only to a device whose hello says
NOTE_PAGES_SCHEMA or later, as an older one drops it and sends the
transcript.

**`RPC_METHODS."notes.read".params.markdownStart`**

Where the page of the body begins, in UTF-16 code units from 0. Needs
`withoutTranscript`. Since 0.31.0; an older host drops it and sends the
whole body.

**`RPC_METHODS."notes.read".params.markdownLimit`**

Most UTF-16 code units of the body to send, 1 to MAX_NOTE_MARKDOWN_PAGE
(the default when a page is read). Fewer come when more would not fit in
a frame or would end inside a surrogate pair. Needs `withoutTranscript`.
Since 0.31.0; an older host drops it.

**`RPC_METHODS."notes.read".result.markdownStart`**

Where `markdown` begins in the whole body: `markdownStart` as asked, one
earlier when that fell inside a surrogate pair, `markdownTotal` when it
was past the end, and 0 when not reading by pages. Since 0.31.0; absent
from an older host.

**`RPC_METHODS."notes.read".result.markdownTotal`**

The length of the whole body in UTF-16 code units; 0 with
`transcriptOnly`. Since 0.31.0; absent from an older host.

**`RPC_METHODS."notes.read".result.recordings`**

The note's recordings (NoteRecordingInfoSchema), in the order
notes.transcript gives them; empty for none. Sent with or without
`withoutTranscript`. Since 0.31.0; absent from an older host.

**`RPC_METHODS."notes.transcript"`**

The lines and speakers of a note's recordings, or of the one `recording`
names (its id or an id prefix). Answer:
`{ id, title, recordings: [{ id, startedAt, participants, start, total, base, revision, lines: [{ id, startMs, endMs, speaker, speakerLabel, speakerName, text }] }] }`.
Without `start` and `limit`, every line of every recording, refused
(Unavailable) when that does not fit in a frame.

**`RPC_METHODS."notes.transcript".params.start`**

The index of the first line to send, from 0. With it or `limit`, one
recording is read a page at a time and `recording` is required
(InvalidParams otherwise). Since 0.31.0; an older host drops it.

**`RPC_METHODS."notes.transcript".params.limit`**

Most lines to send, 1 to MAX_TRANSCRIPT_LINES (the default when a page is
read). The host sends fewer when more would not fit in a frame, so a reader
goes on from `start` plus the lines it got until it has `total`. Since
0.31.0; an older host drops it.

**`RPC_METHODS."notes.transcript".result.recordings.start`**

The index of the recording's first line in this answer: `start` as asked,
or `total` when that was past the end; 0 for a whole transcript. Since
0.31.0; absent from an older host.

**`RPC_METHODS."notes.transcript".result.recordings.total`**

How many lines the recording has in all. Since 0.31.0; absent from an
older host.

**`RPC_METHODS."notes.transcript".result.recordings.base`**

An opaque string naming the recording's lines before `start`, with their
speakers' names and labels and its `participants`. A reader compares it
with the `revision` of the page it took last and reads the recording
again from 0 when they differ. Since 0.33.0; absent from an older host.

**`RPC_METHODS."notes.transcript".result.recordings.revision`**

An opaque string naming the recording's lines from 0 through this
answer's last one, as `base` does. Since 0.33.0; absent from an older
host.

**`RPC_METHODS."chat.instructions.set"`**

Replace the session layer. With from, the receiving device's agent policy applies.

**`RPC_METHODS."chat.instructions".result.session`**

The editable session text. Since 0.16.0. Older hosts only return the combined text.

**`RPC_METHODS."chat.instructions".result.layers`**

The tab's persistent layers in composer order, including empty layers. Since 0.16.0.

**`RPC_METHODS."notes.attach"`**

Puts a photo at the end of a note, as one picked on the serving device
would be: one image a request, small enough for a frame. `src` is where
the note keeps it.

**`RPC_METHODS."notes.attach".params.data`**

Base64, of at most MAX_ATTACHMENT_BYTES bytes.

**`RPC_METHODS."notes.attach".params.name`**

The photo's file name on the phone, which the note's file is named after.

**`RPC_NOTIFICATIONS`**

The notifications a serving device sends, by method.

### `view.ts`

A chat as another device draws it: the conversation the serving device's
app already made of its program's log, trimmed of what only that app
uses. The shapes follow the desktop app's chat model, so its chat view can
draw a remote one as it draws its own; Claude Code's and Codex's own
formats stay on the serving device, which keeps up with their versions.

An item or call of a kind this version does not know stays parseable
(UnknownItemSchema): a newer device may send more, and an older one skips it.

**`ImageRefSchema`**

An image a message or a tool result holds. Its bytes stay on the serving device in v1.

**`ImageRefSchema.bytes`**

How many bytes the image takes.

**`ClientNonceSchema`**

A submission ID generated once by the sending client.

**`ClientSubmission.clientDeviceId`**

Set by the host from the authenticated connection.

**`UserItemSchema.state`**

sent: written to the program; taken: the program read it.

**`UserItemSchema.queued`**

Written during a turn and not read yet: it waits above the composer.

**`UserItemSchema.forkable`**

Codex turn boundary before this message.

**`AssistantItemSchema.forkable`**

Codex turn boundary after this answer.

**`NoticeItemSchema.code`**

interrupted, exited, restarted, compacted, cleared, error…: a code the app names.

**`ReplyAddressSchema`**

Where an agent that sent a message can be answered: its tab, on the
device `deviceId` (absent: the device this chat runs on). `nexus chat
send` takes it as it is.

**`ReceivedItemSchema`**

A message the program took that the user did not write: another session's, a channel's.

**`ReceivedItemSchema.from.device`**

Sent from another device of the account: which one, as it names itself.

**`ReceivedItemSchema.from.replyTo`**

Where the sender takes an answer.

**`ITEM_KINDS`**

The item kinds this version knows.

**`UnknownItemSchema`**

An item of a kind this version does not know: kept so the list stays
whole, and not drawn. A known kind that does not fit its shape is no such item.

**`MAX_RESULT_TEXT`**

Most characters of a tool's result text sent; the rest is cut (`truncated`).

**`ViewToolCallSchema.status`**

streaming, running, done, error, denied, stopped.

**`ViewToolCallSchema.result.structured`**

The program's structured result: a run's stdout, an edit's patch.

**`ViewToolCallSchema.result.truncated`**

The text was longer than MAX_RESULT_TEXT and is cut there.

**`ViewToolCallSchema.parentToolUseId`**

The agent call it runs under; null on the main thread.

**`ViewPermissionSchema`**

A tool the program asks to run, which the user allows or denies.

**`ViewPermissionSchema.agentId`**

A subagent's request.

**`ViewPermissionSchema.preview`**

The call as the card previews it, when the input alone does not tell it.

**`ViewPermissionSchema.suggestions`**

What "always allow" would add, one choice each, in the serving
device's words ("Allow Bash(npm test:*) in this folder"): chat.answer
picks them by index.

**`ViewTaskSchema`**

A task the program runs beside the turn: a background run, a subagent.

**`ViewTaskSchema.outputFile`**

The file its program writes a background run's output to, on that
computer, as its chat there tells it: files.read reads it by this
path, though it is outside the workspace's folders. Since 0.13.0.

**`ViewStreamingSchema`**

The reply being written: what the program streamed of its next message so far.

**`TURN_FAILURE_KINDS`**

How a chat's last turn failed, as `ChatStatusSchema.failure.kind` tells
it: usage_limit (the plan's usage limit), transient (a rate limit, an
overloaded or failing server, a lost connection: trying again may
work), auth (a sign-in or key refused), request (the API refused the
request itself: the same request fails again), other. Since 0.32.0.

**`TurnFailureKindSchema`**

One of `TURN_FAILURE_KINDS`.

**`ChatStatusSchema`**

Where a chat stands, apart from its messages.

**`ChatStatusSchema.model`**

The model it runs, as its program names it.

**`ChatStatusSchema.running`**

A turn is under way.

**`ChatStatusSchema.interrupting`**

The turn was told to stop and has not yet (its stop button pressed). Since 0.13.0.

**`ChatStatusSchema.phase`**

Where its tab there stands with its program, as its banners tell it:
starting, ready, held (waiting to start), ended (it exited; chat.restart
starts it again), not-found (its session is gone) or failed (`error`
says why; "old-version" for a program too old, `version` it); idle
before it opens. Since 0.13.0.

**`ChatStatusSchema.phaseRevision`**

Revision of the process phase, including successive failures with the same details.

**`ChatStatusSchema.error`**

Why it failed, or what was not found. Since 0.13.0.

**`ChatStatusSchema.version`**

Its program's version, as it told it. Since 0.13.0.

**`ChatStatusSchema.signedOut`**

Its program needs a sign-in before a turn can run (a Codex chat's):
signed in there, chat.checkSignIn asks it again. Since 0.13.0.

**`ChatStatusSchema.exit`**

How its program last exited: its code or signal, and the end of what it wrote to stderr. Since 0.13.0.

**`ChatStatusSchema.turn.thinkingTokens`**

The thinking it has done, as its program estimates it. Since 0.13.0.

**`ChatStatusSchema.turn.status`**

requesting, compacting…

**`ChatStatusSchema.turn.retry`**

The API failed and the program tries again: the try it is on, of
how many, after how long a wait. Since 0.13.0.

**`ChatStatusSchema.turn.retry.at`**

When the program said so, in Unix milliseconds: the wait ends `delayMs` after. Since 0.19.0.

**`ChatStatusSchema.turn.retry.status`**

The HTTP status of the error it tries again after; none when no answer came. Since 0.19.0.

**`ChatStatusSchema.turn.retry.reason`**

Why: rate_limit, overloaded, server, connection, auth or other;
another this version does not know reads as other. Since 0.19.0.

**`ChatStatusSchema.failure`**

How its last turn failed, while that is its last result; none once a
turn ends without failing. It may stay while a new turn runs: a reader
shows it only while none runs. Only the kind, the status and the time:
never the error's own words. Since 0.32.0; one this version cannot read
(a kind it does not know) is left out, not the status.

**`ChatStatusSchema.failure.kind`**

One of `TURN_FAILURE_KINDS`.

**`ChatStatusSchema.failure.status`**

The HTTP status of the failed request; none when no answer came.

**`ChatStatusSchema.failure.at`**

When the turn ended, in Unix milliseconds; with kind and status, which
failure a reader's dismissal was for.

**`ViewTodoSchema`**

One step of the agent's to-do list.

**`ViewTodoSchema.status`**

pending, in_progress or completed.

**`ViewAgentRowSchema`**

A subagent the turn called (an Agent tool call).

**`ViewAgentRowSchema.status`**

running, completed, failed or stopped.

**`ViewGoalSchema`**

A goal the chat works toward (/goal), and where it stands.

**`ViewGoalSchema.status`**

active, paused, met or failed.

**`ViewGoalSchema.checks`**

How many checks found it unmet so far.

**`ViewGoalSchema.reason`**

Once it ended: why.

**`ViewGoalSchema.checkReasons`**

The checks that found it unmet, oldest first, with what each said. Since 0.11.0.

**`ViewGoalSchema.usedSeconds`**

A Codex goal: the seconds Codex worked toward it, as of `usedAt`. Since 0.11.0.

**`ViewGoalSchema.tokens`**

The tokens it took so far, and a Codex goal's budget (null: none). Since 0.11.0.

**`ViewGoalSchema.durationMs`**

Once it ended: how long it took, and when. Since 0.11.0.

**`ViewGoalSchema.iterations`**

Once a Claude goal ended: the checks it took, the last that ended it too. Since 0.13.0.

**`ViewUsageMeterSchema`**

A window of the plan's usage limits, as the desktop's line under the
composer shows it (since 0.10.0).

**`ViewUsageMeterSchema.kind`**

session (Claude's five hours), weekly (the week, every model),
weekly_scoped (the week, one model: `scope`), window (a Codex window of
`windowMins`); a kind this version does not know may come.

**`ViewUsageMeterSchema.percent`**

How much of it is spent, from 0 to 100.

**`ViewUsageMeterSchema.resetsAt`**

When it starts over, in Unix milliseconds.

What the chat's side panel shows beside the conversation: the to-do
list, the tasks and subagents, the files it changed, the context it
fills, what it cost, and its goal.

**`MAX_HELD_TEXT`**

The most of a held message's text the panel tells; chat.unqueue gives all of it.

**`ChatPanelSchema.tasks`**

Background runs and the like, by the program's task ids (chat.stopTask stops one).

**`ChatPanelSchema.changedFiles.path`**

Absolute, on the serving device, as the chat's tool calls name it.

**`ChatPanelSchema.changedFiles.rawPath`**

The path as the first finished change of the file wrote it, only where it
differs from `path` (a Windows path's backslashes and drive letter case).
For showing; `path` is what file actions take. Since 0.34.0.

**`ChatPanelSchema.changedFiles.created`**

The chat made it: its first change wrote it new. Since 0.13.0.

**`ChatPanelSchema.context`**

The context window: tokens in it, and how many it takes; null before the program said.

**`ChatPanelSchema.context.categories`**

What fills it, by kind (the system prompt, tools, messages), as a
Claude chat's program tells it. Since 0.13.0.

**`ChatPanelSchema.context.freeTokens`**

How many of its tokens are free, as a Claude chat's program tells it. Since 0.13.0.

**`ChatPanelSchema.costUsd`**

What the conversation cost so far, in US dollars, when the program tells it.

**`ChatPanelSchema.planLimits`**

The plan's usage limits, for a profile signed in with a subscription:
those the desktop shows (the session's and the week's first), none
for one that pays by API key, whose cost `costUsd` tells. Since 0.10.0.

**`ChatPanelSchema.rateLimit`**

The program's own word on the plan's limit, as the desktop's banner
over the composer shows it: allowed_warning when near, rejected when
reached, until `resetsAt` (Unix milliseconds). Since 0.11.0.

**`ChatPanelSchema.rateLimit.kind`**

five_hour, seven_day… as the program names the window.

**`ChatPanelSchema.limitResume`**

A chat the plan's usage limit stopped, of a subscription's profile:
whether and when its app goes on in it by itself. state: waiting (it
sends the agent a message to go on at `at`), unknown (no reset time;
nothing scheduled), cancelled (by the user), gave_up (the limit held
after the most tries); another this version does not know reads as
none. Times in Unix milliseconds. Since 0.19.0; one this version cannot
read is left out, not the panel.

**`ChatPanelSchema.limitResume.stopAt`**

Time of the turn result that hit the limit, in Unix milliseconds.

**`ChatPanelSchema.mcp`**

The MCP servers the chat's program has, and how each stands (connected, failed…). Since 0.11.0.

**`ChatPanelSchema.session`**

What the chat's program runs as: its session's id, its version, the account it is signed in with. Since 0.11.0.

**`ChatPanelSchema.session.account`**

As the desktop's panel shows it: email · organization · plan.

**`ChatPanelSchema.remoteControl`**

Claude Code's Remote Control: whether its program can turn it on,
whether it is on, and the session's address there while it is
(chat.remoteControl turns it). Since 0.11.0.

**`ChatPanelSchema.moves`**

Where the conversation went on in another profile: after the item
whose key is `after`, in the profile named `profile` (profiles.list's
name), at `at`. Since 0.11.0.

**`ChatPanelSchema.twin`**

A terminal tab in the same workspace whose Claude Code runs this
chat's session too, as its hooks told the host: `tabId`, as the
sessions' list names it. Going on in both forks the conversation. A
Claude chat's only, and only a terminal tab. Since 0.32.0; one this
version cannot read is left out, not the panel.

**`ChatPanelSchema.can`**

What another device can do with the chat now: rewind it to before one
of the user's messages (chat.rewind), fork it (chat.fork), send a
running command or subagent to the background (chat.background).
Absent before 0.11.0, which serves none of them; a Codex chat's comes
from 0.13.0.

**`ChatPanelSchema.can.now`**

Send into the turn at once (chat.send `now`). Since 0.12.0.

**`ChatPanelSchema.can.withdraw`**

Take back an unread message (chat.withdraw). Since 0.12.0.

**`ChatPanelSchema.can.hurry`**

Have the unread messages read now (chat.hurry). Since 0.12.0.

**`ChatPanelSchema.can.moveNow`**

Move it to another profile while it works or waits on the user, its
turn stopping (chat.profile `stop`), as its chip there does. Since 0.13.0.

**`ChatPanelSchema.can.mcp`**

Work its MCP servers: sign in, connect again, turn on or off (chat.mcp). Since 0.13.0.

**`ChatPanelSchema.can.mcpStatus`**

Refresh Codex MCP inventory with chat.command (mcp refresh).

**`ChatPanelSchema.can.clientNonce`**

Correlates user submissions in chat.send, watch and read.

**`ChatPanelSchema.can.config`**

Read and change its Claude Code settings, or a Codex chat's defaults (chat.config). Since 0.13.0.

**`ChatPanelSchema.held`**

The messages held for after the turn (chat.send `after`), in the order
they go: each's text cut to MAX_HELD_TEXT (`truncated`), and how many
images and files it carries. Since 0.12.0.

### `layout.ts`

### `peek.ts`

Making a chat.peek answer (since 0.27.0): its texts cut by code points,
a turn's tools counted, and the whole fitted in MAX_PEEK_BYTES, as
ChatPeekSchema says. A serving device builds its answer, then fits it.

**`clipHead`**

The text in at most `max` characters (code points), its start kept: when
cut, it ends with "…", which counts in `max`.

**`clipTail`**

The text in at most `max` characters (code points), its end kept: when
cut, it begins with "…", which counts in `max`.

**`peekTools`**

A turn's tool calls, by the names their program gives them, in the order
they were called, counted as a peeked turn tells them: each name cut at
MAX_PEEK_TOOL_NAME (names cut alike count together), the MAX_PEEK_TOOLS
most called (a tie to the one called first), the rest's calls added up
in `otherTools`, left out when none.

**`peekTools.ranked (how it works)`**

A Map keeps the order names first came in, and sort is stable.

**`peekTools (how it works)`**

An own property, even for a name such as "__proto__".

**`fitPeek`**

The answer with each text cut at its limit, and then fitted in
MAX_PEEK_BYTES: the oldest turns left out (with `more`), down to one;
then the last turn's `reply`, its `user.text`, `status.streaming` and
its `received.text` cut shorter, in that order, each as far as needed.
What is under the budget comes back as it was, but for the cuts.

**`fitPeek.out (how it works)`**

A copy as JSON has it (what is measured), without structuredClone, which not every runtime has.

**`fitPeek.texts (how it works)`**

The texts to cut shorter: how each is read and written, and whether its end is kept.

**`fitPeek.low (how it works)`**

The longest that fits, found by halves; at least "…".

### `account.ts`

The account key, locked with the account password: the server keeps the
locked bundle and hands it to the account's devices, which open it on
their own (see ../ACCOUNT_KEYS.md). The server never sees the password,
the key, or anything made from them; it only checks the bundle's shape.

**`bundleAadOf`**

The associated data the key is sealed with: the user's id and the key's version, so a bundle cannot pass for another's.

**`KdfSchema`**

Argon2id's settings, as libsodium's crypto_pwhash takes them (ALG_ARGON2ID13).

**`KdfSchema.ops`**

crypto_pwhash's opslimit.

**`KdfSchema.mem`**

crypto_pwhash's memlimit, in bytes.

**`KdfSchema.salt`**

16 random bytes.

**`DEFAULT_KDF`**

The settings a new bundle is locked with; a bundle keeps its own, so these can grow.

**`MAX_OPEN_KDF`**

The heaviest settings a device opens a bundle with, DEFAULT_KDF's room to
grow. KdfSchema takes more, for bundles locked so already; but a bundle
past these, as a server could hand out, would hold up the device for long
while it unlocks, so a device says it cannot open it instead.

**`KeyBundleSchema`**

The account key (32 bytes) sealed with XChaCha20-Poly1305 under the key
the password makes with `kdf`, with bundleAadOf(userId, kid) as the
associated data. `kid` is the account key's version, which sealed frames
name; it goes up when the key is made anew.

**`KeyBundleSchema.nonce`**

24 random bytes.

**`VerifierSchema`**

SHA-256 of the password's proof (authKey, see ./device-keys.ts),
base64url: what the server keeps to check the proof with.

**`PendingResetSchema`**

A reset asked for without the password, which waits (see ./device-keys.ts).

**`PendingResetSchema.appliesAt`**

When it is put in place, in Unix ms.

**`PendingResetSchema.deviceId`**

The device that asked for it.

**`KeyBundleResponseSchema`**

GET /account/key-bundle: the bundle and its version on the server, or 404 before there is one.

**`KeyBundleResponseSchema.version`**

Counts the bundle's writes, for the next PUT to say which one it replaces.

**`KeyBundleResponseSchema.pendingReset`**

A reset that waits, if one does.

**`KeyBundlePutSchema`**

PUT /account/key-bundle. `expected` is the version it replaces, or null
for the first bundle; the server answers 409 when another write came
first. A new password locks the same key (same kid); a reset puts a new
key (kid + 1), which the account's other devices take once they are told
the new password.

**`KeyBundlePutSchema.verifier`**

The verifier of the password the bundle is locked with. A write after
the first needs the password's proof of the bundle it replaces
(ACCOUNT_AUTH_HEADER).

### `device-keys.ts`

Account keys v2 (see ../ACCOUNT_KEYS.md): a key pair of each device's,
vouched for with the account key; the account key handed to another
device through a QR code (pairing) or sealed for each device that stays
when one is removed (rotation); and the proof of the account password the
server asks before what only the account's owner may do.

The server keeps and checks the shapes below. It cannot make a
certificate, open an envelope or a pairing frame, or learn the password
from its proof.

#### The password's proof

**`ACCOUNT_AUTH_INFO`**

The HKDF info that makes the password's proof (authKey) from the key the
password makes with a bundle's kdf (KEK).

**`ACCOUNT_AUTH_HEADER`**

The header that carries authKey (32 bytes, base64url) where the server
asks for the password: a bundle's write, a rotation, removing another
device, deleting the account, calling off a reset.

**`ACCOUNT_AUTH_ERROR`**

What the server answers, with 403, when the header is missing or does
not match: `{ "error": ACCOUNT_AUTH_ERROR }`.

#### A forgotten password: a reset that waits

**`RESET_DELAY_MS`**

How long a reset asked for without the password waits before it is put in place.

**`KeyResetPostSchema`**

POST /account/key-reset, without the password: a new key (kid + 1)
locked with a new password, which the server puts in place after
RESET_DELAY_MS unless a device that knows the password calls it off
(DELETE /account/key-reset, with the header). 409 while one waits.

#### Device keys

**`DEVICE_CERT_KEY_INFO`**

The HKDF info that makes the key certificates are made with from the account key.

**`deviceCertInputOf`**

What a device's certificate is the HMAC-SHA256 of: the device, its
public key (base64url, as it travels), and the account key's version
that vouches for it.

**`DeviceKeySchema`**

A device's X25519 public key (32 bytes), and its certificate under the
account key of version `kid`: HMAC-SHA256 of deviceCertInputOf with
HKDF-SHA256(account key, DEVICE_CERT_KEY_INFO). Only a device holding
that account key can make or check it.

**`DeviceKeyPutSchema`**

PUT /devices/current/key: this device's key, when it gets the account
key and when its version changes without a rotation vouching for it anew.
The server drops this device's envelopes of that version or older.

#### Envelopes and rotation

**`envelopeInfoOf`**

The HKDF info, and the associated data, an envelope is sealed with: who
seals it for whom, and the account key's version it carries.

**`KeyEnvelopeSchema`**

The account key of version `kid` sealed for one device by the device
`from`: XChaCha20-Poly1305 of the 32 key bytes under HKDF-SHA256 of
X25519(from's secret key, the receiver's public key), with
envelopeInfoOf as the info and as the associated data. `fromKey` is the
sender's key under the version before (kid - 1), which the receiver
checks with the account key it holds before it opens the box.

**`KeyEnvelopeSchema.nonce`**

24 random bytes.

**`KeyEnvelopesResponseSchema`**

GET /devices/current/key-envelopes: this device's envelopes, oldest version first.

**`KeyRotationSchema`**

POST /account/key-rotation, with the password's header: a new account
key (kid + 1) locked with the password typed now, the devices removed
with it, an envelope for each device that stays and holds a key of the
version before, and their keys vouched for anew. The server does it all
at once or not at all (409 when `expected` is not the bundle's version).

**`KeyRotationSchema.certs`**

Each staying device's key (the rotating one's too) under the new version; its public key as the server has it.

#### Pairing

**`PAIR_KID`**

The kid of a relay frame sealed with a pairing key, not the room key.

**`PAIR_TTL_MS`**

How long a pairing QR code holds.

**`PAIR_URI_PREFIX`**

The URI a pairing QR code holds.

**`PairCodeSchema`**

What a pairing QR code tells: the account, the device showing it, and a one-time secret (32 bytes).

**`pairUriOf`**

The text of a pairing QR code: `nexuscode://pair?v=1&u=<userId>&d=<deviceId>&s=<secret>`.

**`parsePairUri`**

The pairing code in a QR code's text; null when it holds none.

**`pairKeyInfoOf`**

The HKDF info that makes a pairing key from a code's secret: the account and the device showing it.

**`PairMessageSchema`**

What a pairing frame carries, sealed as a message is (XChaCha20-Poly1305,
aadOf as associated data, kid PAIR_KID) under HKDF-SHA256(code's secret,
pairKeyInfoOf):
- pair-request: a device without the account key, which scanned the
  code a device holding it shows, asks for it;
- pair-key: the account key and its version;
- pair-done: the device took it;
- pair-refused: the user turned it down, or the code ran out; or the two
  devices cannot pair, as both hold the account key or neither does.

### `push.ts`

The push API: a phone registers its APNs token and a computer asks the
server to notify the account's phones when something waits on the user.

PUT /push/registration?v=1 returns 204. Its errors are `bad_request`,
`unsupported_environment`, `unsupported_version` (400), and `not_a_phone`
(403). DELETE /push/registration clears the registration and returns 204.
POST /push/send?v=1 returns a PushSendResult (200). Its errors are
`bad_request`, `unsupported_version` (400), `not_a_computer` (403), and
`push_unavailable` (503, a server without a push key).
Registration and send may also return 429 when rate limited.

**`PUSH_EVENT_ID_PATTERN`**

A computer makes 22 base64url characters from 16 random bytes and keeps the same id on retries.
It makes one id per thing that waits on the user (a consent prompt, or a
chat's waiting request) and sends every push for it again with that id, so
the server may use the id as the APNs `apns-collapse-id` (at most 43
bytes, under APNs' 64). It stops sending once the prompt is answered or
withdrawn, or the request no longer waits; something that waits again
later gets a new id.

**`PUSH_TTL_SECONDS`**

The server clamps each notification's TTL to its kind's range, in seconds.
A consent's longest is a day since 0.30.0 (120 seconds before), for a
prompt that waits until its user answers.

**`PushRegistrationSchema`**

PUT /push/registration?v=1: a phone's token and the notifications it wants.

**`PushSendSchema`**

POST /push/send?v=1: one event for the account's phones, or the phones in `to`.

**`PushSendSchema.ttl`**

Seconds from when the server takes the request, before it clamps to the kind's range.

**`PushSendResultSchema`**

A send's counts, or that the server has already seen this event.

**`PushSendResultSchema.reasons`**

How many phones were skipped for each reason, only those above 0. The
keys known now are `unregistered`, `kind`, `signedOut`, `limited` and
`failed`; a newer server may add others.

**`PushPayloadSchema`**

The `nx` data a phone gets with a notification. The server makes the APNs `aps` part.

### `voice.ts`

The voice socket: what a device says goes to the server as audio and
comes back as text while it speaks (streaming speech to text).

GET /voice?v=1&lang=<language> upgrades to a WebSocket, signed in as
/relay is (a Bearer header, or ?ticket= from POST /relay/ticket). Then:
- server: `ready`, naming the audio format and sample rate to send, and
  the most seconds this session may take;
- client: binary frames of audio in that format, about 100 ms each, as
  they are captured (no faster than real time, give or take a burst of
  a few seconds: audio coming much faster ends the session with a
  `bad-frame` error and 1008), then `end` when the user stops. A
  session open far longer than the audio it has had is ended;
- server, as they come: `partial` (the words so far of the segment being
  spoken; each replaces the last) and `final` (a finished segment, to
  append; it clears the partial). Every partial and final after the
  session's first final starts with the space its language puts between
  segments (none for ja or zh): the text is the finals joined as they
  came, then the partial, with nothing trimmed or added between;
- server: `limit` if the audio ran past what the session or the
  account's quota allows (audio past it is dropped; finals still come);
- server: `done` with the seconds counted, once every final is out; then
  it closes (1000). An `error` ends the session; it closes after.

`&purpose=note` asks for a note's recording instead of a dictation:
- its seconds count against the month's note quota, apart from
  dictation's, and the server may let it run longer (`ready.maxSeconds`
  says how long); a device that records longer opens another session;
- it tells voices apart: each partial and final carries `speaker`, the
  provider's label for a voice ("1", "2", ...), the same for that voice
  for the rest of the session. A final holds one speaker's words, so a
  change of speaker ends a segment;
- each final carries `startMs` and `endMs`, where its words start and end
  in the session's audio, from its first frame;
- `done` carries `transcribeToken` (not for a session under 5 seconds):
  it lets the device send the session's recording once to POST
  /voice/transcriptions for a second pass over the whole file (a more
  accurate text and speakers). Only the recording's seconds beyond the
  live session's count against the quota again. An `error` may carry one
  too, when the session had audio worth hearing again; a device that gets
  none from it (or from a server that never sends one) has no second pass
  for that session.

The second pass (`purpose=note` sessions only), signed in as /voice is:
- POST /voice/transcriptions?v=1&lang=<language>, header
  `X-Transcribe-Token`, body the recording (audio/webm or audio/ogg with
  Opus, or audio/wav), at most MAX_TRANSCRIBE_BYTES and about as long
  as the live session: 202 with `{ id }`. 403 if the token is unknown,
  used or expired; 403 `quota_exceeded` if it would go over the month's
  note quota, and 429 `too_many_transcriptions` while the account has
  three under way whose length is not known yet (the token stays good
  after either); 413 if the body is too big or too long;
- GET /voice/transcriptions/<id>: a Transcription, `pending` until it is
  `done` (with its segments) or `error`; ask again every few seconds;
- DELETE /voice/transcriptions/<id>: 204; the server and its provider
  drop the recording and the text. The server drops them a day after
  anyway.

**`MAX_AUDIO_FRAME_BYTES`**

Most bytes in one audio frame (2 s of 16 kHz 16-bit mono); an even count.

**`VoiceLanguageSchema`**

The language to hear, BCP 47-ish: "ko", "en", "en-US", or "multi" to detect it.

**`VoicePurposeSchema`**

What a voice session is for: a dictation into a text box, or a note's recording.

**`TRANSCRIBE_TOKEN_MS`**

How long a `done`'s (or `error`'s) transcribeToken stays good for.

**`MAX_TRANSCRIBE_BYTES`**

Most bytes of a recording POST /voice/transcriptions takes (about 8 hours of 24 kbps Opus).

**`VoiceClientMessageSchema`**

What a device sends besides audio: that the user stopped speaking.

**`SpeakerSchema`**

The provider's label for a voice in one session or transcription: "1", "2", ...

**`VoiceReadySchema.sampleRate`**

The rate to send at; it may change with the provider, so it is not to be assumed.

**`VoiceReadySchema.maxSeconds`**

The fewer of the session's limit and what is left of the month's quota.

**`VoiceServerMessageSchema.speaker`**

A note's session: whose words they are.

**`VoiceServerMessageSchema.speaker`**

A note's session: whose words they are.

**`VoiceServerMessageSchema.startMs`**

A note's session: where the words start in the session's audio, in ms.

**`VoiceServerMessageSchema.endMs`**

A note's session: where the words end in the session's audio, in ms.

**`VoiceServerMessageSchema.transcribeToken`**

A note's session of 5 seconds or more: lets its recording go once to
POST /voice/transcriptions.

**`VoiceServerMessageSchema.code`**

bad-frame: a frame not of the format, or audio coming much faster than
real time. unauthorized: the device's sign-in ended (the socket closes
4001 after it).

**`VoiceServerMessageSchema.transcribeToken`**

A note's session that had audio worth hearing again: as `done`'s, lets
its recording go once to POST /voice/transcriptions. Missing from a
server that does not send one.

**`VoiceUsageSchema`**

GET /voice/usage: this month's seconds, used and allowed.

**`VoiceUsageSchema.period`**

The month, as YYYY-MM.

**`VoiceUsageSchema.usedSeconds`**

Dictation's.

**`VoiceUsageSchema.note`**

Notes' recordings', counted apart; missing from a server without them.

**`TranscriptSegmentSchema`**

One speaker's stretch of a recording, as the second pass heard it.

**`TranscriptionSchema`**

GET /voice/transcriptions/<id>: a second pass, waiting, done or failed.

**`TranscriptionSchema.segments`**

In order of their start; speakers labelled anew, not as the live session had them.

**`TranscriptionSchema.seconds`**

The recording's length.

### `commands.ts`

**`CodexClientCommand`**

The slash commands a Codex client runs itself. Codex's app-server leaves
them to the client, so the desktop app and a remote device both need the
same list: names, aliases and argument hints, nothing else.

**`CODEX_COMMANDS`**

Codex's slash commands the client handles, not the app-server.

**`CODEX_REMOTE_COMMANDS`**

Codex's client commands that another device may run, by name.

### `info.ts`

GET /info, signed in or not: what the server offers, so a device shows
only what works there.

**`ServerInfoSchema.signIn`**

The sign-ins the server has, each its own /auth/<name>/start. A device
offers one button for each it knows. "dev" is only for local servers.

**`ServerInfoSchema.voice`**

Null where the server has no speech-to-text provider: no microphone then.

**`ServerInfoSchema.accountKeys`**

Account keys v2 (device keys, rotation, the password's proof, a reset
that waits): `{ version: 2 }` where the server has them. Absent or null
before; a device then keeps to v1. Pairing needs nothing of the server.

**`ServerInfoSchema.push`**

The push API and its APNs environments. Null without push keys, absent from older servers.

**`ServerInfoSchema.push.environments`**

Known environments are `production` and `sandbox`. New ones may be added.

### `validation.ts`

**`NumberSchema`**

Keep the numeric domain of the 0.19.0 wire schemas. Zod 4's built-in
number and integer schemas reject infinities and unsafe integers.

**`wireRecord`**

Zod 3 validated an own __proto__ entry before dropping it from a record.

