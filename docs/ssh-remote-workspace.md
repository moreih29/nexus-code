# SSH Remote Workspace — Phase 1 smoke test guide

This guide walks through the interactive (password) authentication path end to
end against the Docker fixture so a human can verify what the unit and Bun-test
suite cannot: that node-pty inside Electron actually emits prompts, that
ControlMaster reuse works on macOS, and that bootstrap upload + manifest +
sha256 verification round-trip against a real sshd.

## Prerequisites

- Docker Desktop running.
- `~/.ssh/id_ed25519.pub` (or another key) — used by the key fixture, not by
  this smoke test, but `docker compose up` may refuse to start the `linux`
  service without it. The `linux-password` service does not need a key.
- The Go nexus-server build (`bash scripts/build-nexus-server.sh`) finished
  and produced `dist/nexus-server/manifest.json` plus the 4-arch binaries.

## 1. Bring up the password fixture

```sh
cd docker/ssh-fixture
docker compose up -d --build linux-password
ssh -p 2223 -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null nexus-dev@127.0.0.1 'echo ok'
# expected: prompts for password "nexus-dev" then prints "ok"
```

Default password is `nexus-dev` (override via `USER_PASSWORD` in
`docker/ssh-fixture/.env` if you need to test wrong-password retries with a
different value).

## 2. Reset local state

So the smoke test exercises a clean first-connect path:

```sh
# Remove any cached server install on the fixture host.
ssh -p 2223 nexus-dev@127.0.0.1 'rm -rf ~/.nexus-code'
# Remove the local nexus-code SQLite workspace state (your real workspaces
# will be wiped — back them up if needed).
# macOS: ~/Library/Application Support/nexus-code/
# Linux: ~/.config/nexus-code/
```

## 3. Run Electron dev build

```sh
bun run dev
```

Electron should open the renderer with no SSH workspaces.

## 4. Add a remote workspace

1. Click "Add Workspace" → choose "SSH".
2. Fill in:
   - Host: `127.0.0.1`
   - User: `nexus-dev`
   - Port: `2223`
   - Remote path: `/home/nexus-dev/workspace`
   - Authentication: leave as **Interactive** (default).
3. Click "Test SSH" first. Expected sequence of dialogs:
   - **Host key prompt** — verify the dialog shows:
     - The fingerprint in monospace, 14px, on its own line.
     - "If you don't recognize this fingerprint, do not trust the host."
     - "Trust applies for this session only."
     - A "Copy" button next to the fingerprint.
   - Click "Trust".
   - **Password prompt** — verify:
     - Title "SSH password required".
     - Context line `nexus-dev@127.0.0.1:2223` in monospace.
     - Input is masked.
   - Enter the **wrong** password first (e.g. `wrong`). Expected:
     - A second password dialog appears with an inline alert:
       > Authentication failed. Try again.
     - The input is cleared and focused.
   - Enter the correct password (`nexus-dev`). Expected:
     - Brief connecting state, then a success indicator (Test SSH passes).
4. Click "Add Workspace" to create the workspace.

## 5. Verify bootstrap

```sh
ssh -p 2223 nexus-dev@127.0.0.1 'ls -la ~/.nexus-code/bin ~/.nexus-code/manifest.json'
```

Expected:
- `~/.nexus-code/bin/nexus-server-0.1.0-linux-arm64` (or `-amd64` depending on
  your host arch) with mode `0755`.
- `~/.nexus-code/manifest.json` containing matching `version`, `os`, `arch`,
  `sha256`, `installedAt`.

Compare the remote sha256 with the local manifest:

```sh
ssh -p 2223 nexus-dev@127.0.0.1 'sha256sum ~/.nexus-code/bin/nexus-server-*' | cut -d' ' -f1
jq -r '.binaries[] | select(.os=="linux" and .arch=="arm64") | .sha256' \
    dist/nexus-server/manifest.json
# the two hashes must match
```

## 6. Explore the remote workspace

In Electron:
1. Open the file tree — `README.md` and `src/` should appear.
2. Open `src/hello.ts` — the file content should load.

## 7. Re-connect path

1. Close the workspace tab (or restart Electron).
2. Re-open the workspace.
3. The password prompt should reappear (the master socket has a 60s persist;
   if you reconnect within that window, no prompt is expected).
4. After auth, the bootstrap step should be silent: open the renderer devtools
   console and confirm there is no "Uploading server" toast — the manifest
   matches and scp is skipped.

## 8. Cancel path

1. Add another SSH workspace (same host) — pass the host-key prompt, then
   cancel the password dialog with Esc or Cancel.
2. Expected:
   - The dialog closes.
   - A non-destructive toast appears ("Connection to 127.0.0.1 canceled" or
     equivalent).
   - The Add Workspace wizard is recoverable; you can re-open and retry.

## 9. Key-only regression

1. Add a workspace with `linux` (key-auth, port 2222) instead — set
   Authentication to **Key only**.
2. Expected:
   - No PTY prompt.
   - Channel uses `BatchMode=yes` directly.
   - Bootstrap still runs (manifest write + scp) because authMode does not
     affect bootstrap presence, only the auth surface.

## Failure modes to spot-check

- **Wrong password 3+ times**: dialog keeps re-opening with the retry alert
  until you cancel; cancelling returns control to the workspace wizard.
- **Manifest mismatch / sha256 mismatch**: corrupt the remote binary
  (`ssh ... 'echo broken > ~/.nexus-code/bin/nexus-server-*'`) then re-connect.
  Expected: bootstrap detects mismatch, re-uploads, sha256 verifies, manifest
  rewritten. If the local manifest is tampered with, expect
  `server.protocol-error` and a connection failure.
- **Wrong port / unreachable host**: `ssh.connect-failed`, no PTY shown.

## Known limits in Phase 1

- Host-key "Trust" is session-only; no `known_hosts` write yet. Each new
  Electron run re-prompts on first connect.
- `node-pty` integration tests run via a Node-backed adapter to work around a
  Bun-specific deadlock with native callbacks. The Electron runtime uses
  node-pty directly — this smoke test is the only path that covers that.
- Only `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64` binaries
  are produced. Windows fixtures and binaries are out of scope.
