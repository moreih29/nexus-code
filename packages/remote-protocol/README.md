# @nexus-code/remote-protocol

The protocol between a NexusCode user's devices and the relay that connects them, as zod schemas.

There are two layers:

- **Relay frames** (`relay.ts`): what a device and its account's room on the relay send each other. The relay reads these: who a message is for, its sequence number, and the account key version it was sealed with. It cannot read the message itself.
- **Sealed messages** (`sealed.ts`, `rpc.ts`, `view.ts`): what a sealed frame carries between two devices of the account.
  - A `hello` that says which protocol version and capabilities a device serves.
  - JSON-RPC 2.0 requests, answers and notifications: list and watch sessions and their changes, read and drive chats, read, watch and drive terminals, wait on either, answer the consent prompts waiting on the user, and read a workspace's files (find them by name, search their text, read them as text, images or bytes piece by piece) and git (status, diffs, log, a commit and its changes). What a device serves is per capability (`CAPABILITIES`); a hello's `schema` names the package version it speaks (`SCHEMA_VERSION`).
  - The chat view: the conversation as the serving device's app already built it, trimmed for drawing.

Beside them:

- **The account key's bundle** (`account.ts`): the account key locked with the account password, as the server keeps it. See `ACCOUNT_KEYS.md`.
- **The voice socket** (`voice.ts`): audio to the server, text back while the user speaks.

Sealing is XChaCha20-Poly1305. The key is the room key, derived from the account key. The associated data comes from `aadOf()` and binds a message to its routing.

Until it is published, other repos use it by a local path, e.g. `"@nexus-code/remote-protocol": "file:../nexus-code/packages/remote-protocol"`, after `npm run build` here: its exports point at `dist`. They need `zod` 3.25 or later.

## Use and publish

Published as `@nexus-code/remote-protocol`: ES modules with their type
declarations in `dist`, and `zod` 3.25 or later as a peer. The desktop app
imports `src` directly; `npm run build` (run by `prepublishOnly`) makes
`dist`. Relative imports in `src` end in `.js`, as Node's ES modules need
them.

A version is published by GitHub Actions (`.github/workflows/publish-remote-protocol.yml`)
when a tag `remote-protocol-vX.Y.Z` naming the version in `package.json` is pushed:
trusted publishing, with no token or one-time password, and with provenance.
