# @nexus-code/remote-protocol

The protocol between a NexusCode user's devices and the relay that connects them, as zod schemas.

There are two layers:

- **Relay frames** (`relay.ts`): what a device and its account's room on the relay send each other. The relay reads these: who a message is for, its sequence number, and the account key version it was sealed with. It cannot read the message itself.
- **Sealed messages** (`sealed.ts`, `rpc.ts`, `view.ts`): what a sealed frame carries between two devices of the account.
  - A `hello` that says which protocol version and capabilities a device serves.
  - JSON-RPC 2.0 requests, answers and notifications: list and watch sessions, read and drive chats, read terminals.
  - The chat view: the conversation as the serving device's app already built it, trimmed for drawing.

Beside them:

- **The account key's bundle** (`account.ts`): the account key locked with the account password, as the server keeps it. See `ACCOUNT_KEYS.md`.
- **The voice socket** (`voice.ts`): audio to the server, text back while the user speaks.

Sealing is XChaCha20-Poly1305. The key is the room key, derived from the account key. The associated data comes from `aadOf()` and binds a message to its routing.

The package is not published yet. Other repos use it by a local path, e.g. `"@nexus-code/remote-protocol": "file:../nexus-code/packages/remote-protocol"`, and need `zod` 3.25 or later.
