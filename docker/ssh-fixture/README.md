# SSH test fixture

Docker-based SSH server for verifying the SSH remote workspace path
(`feat/ssh-remote-workspace`). Two Ubuntu 22.04 arm64 containers — one
key-auth (`127.0.0.1:2222`), one password-auth (`127.0.0.1:2223`) —
no node/bun/python on the remote, by design. Claude Code (native
self-contained binary) is pre-installed for TUI scenarios — see
[Claude Code in the fixture](#claude-code-in-the-fixture).

## Layout

```
docker/ssh-fixture/
├── Dockerfile           # ubuntu:22.04 + openssh-server + git + ripgrep + claude
├── compose.yml          # linux (2222, key), linux-password (2223, password)
├── .env.example         # SSH_PUBKEY template
└── workspace-seed/      # bind-mounted to /home/nexus-dev/workspace
    ├── README.md
    └── src/hello.ts
```

## One-time setup

```sh
cd docker/ssh-fixture
cp .env.example .env
# Edit .env so SSH_PUBKEY is your public key, e.g.:
#   SSH_PUBKEY=$(cat ~/.ssh/id_ed25519.pub)
```

Append the following to `~/.ssh/config` (the Add Workspace dialog reads this
file for the SSH alias dropdown):

```ssh-config
Host nexus-test-linux
  HostName 127.0.0.1
  Port 2222
  User nexus-dev
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  BatchMode yes
```

`StrictHostKeyChecking no` + `UserKnownHostsFile /dev/null` is **fixture-only**
— the container regenerates host keys on every rebuild, so pinning is moot.
Do not copy this block to production hosts.

## Bring up

```sh
cd docker/ssh-fixture
docker compose up -d --build           # both services
# or one at a time:
docker compose up -d --build linux
docker compose up -d --build linux-password
```

## Smoke test

```sh
# Key path — sshd responds, key auth works.
ssh nexus-test-linux exit && echo "key ok"

# Password path — verify the PTY + prompt path.
# Default password: "nexus-dev" (override via USER_PASSWORD in .env).
ssh -p 2223 -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null nexus-dev@127.0.0.1 exit
# (will prompt for password interactively)

# Architecture + workspace mount visible.
ssh nexus-test-linux 'uname -ms; ls workspace'
# expected: Linux aarch64 / README.md src

# Push the Go server binary and round-trip an fs.readdir.
# (Implementation pending — see plan step S7.)
```

## Inspect / iterate

```sh
docker compose logs -f linux                 # sshd log on stderr (key)
docker compose logs -f linux-password        # sshd log on stderr (password)
docker compose exec linux bash               # shell as root for debugging
ssh nexus-test-linux                         # shell as nexus-dev (intended path)
```

## Claude Code in the fixture

The image installs Claude Code via the official native installer
(`https://claude.ai/install.sh`) as `nexus-dev`. It is a self-contained
binary under `~/.local/share/claude` — it does **not** put node/bun on
`PATH`, so the "zero host runtime" premise below still holds.

Login is per-environment and never baked into the image. Log in once:

```sh
ssh -p 2223 nexus-dev@127.0.0.1   # password: nexus-dev
claude                            # → /login → open URL on host browser → paste code
```

Credentials land in `~/.claude/.credentials.json`, which is a named
volume (`claude-config-key` / `claude-config-password`), so the login
survives image rebuilds and container re-creation. The two services use
separate volumes on purpose — sharing one token file between two live
containers risks refresh races. `docker compose down -v` wipes the
volumes (= logs you out everywhere).

`~/.claude.json` (onboarding/theme state) lives in the home root, *not*
in the volume — after a rebuild Claude re-asks onboarding questions but
stays logged in.

## Simulating SSH disconnects

`docker pause` freezes every process in the container: TCP stays
ESTABLISHED but sshd stops answering SSH-layer keepalive probes —
indistinguishable, at the SSH protocol level, from a yanked cable or
dropped Wi-Fi. `unpause` restores it. Measured behavior (ssh with
`ServerAliveInterval=5/CountMax=3`, i.e. a 15s window):

- pause < window → session **survives untouched**; output resumes on
  unpause as if nothing happened.
- pause > window → local ssh exits with
  `Timeout, server not responding` (observed at 16s with the 15s window).

```sh
# Reproduce a transient drop against a live app session:
docker pause nexus-ssh-linux-password
sleep 60                                  # > 15s: past the app's 3-miss heartbeat window
docker unpause nexus-ssh-linux-password

# Short blip variant (app should never notice):
docker pause nexus-ssh-linux-password && sleep 20 \
  && docker unpause nexus-ssh-linux-password
```

Timeline against the app's production settings (heartbeat 5s advertised
by the agent, client 3-miss policy = 15s detection; daemon reattach
grace 300s — `cmd/agent/main.go` / `cmd/agent/daemon.go`). Since the
daemon/dialer split, the agent runs detached from the SSH session
(`--daemon`, setsid) and each SSH session is a disposable `--dial`
relay, so terminal sessions survive any drop shorter than the grace:

| pause duration | what happens (verified 2026-06-05) |
|---|---|
| < ~15s | sidebar dot pulses "unstable" at 1 missed heartbeat (~5s); nothing else — PTYs untouched |
| ~15s–300s | client declares the channel dead at 3 misses (~15s) → terminals **held** (dim + "session preserved" banner with grace countdown), input dropped with a hint → on recovery the new dialer reattaches to the surviving daemon (measured 127ms after unpause), `session.list`+`pty.replay` restore the screens, same shell/claude PIDs |
| > 300s | daemon idle watchdog reaps it (exit 75), SIGKILLing PTY children → reconnect finds a new daemon (epoch mismatch) → workspace settles in "session expired" (distinct from connect-failure), terminals offer restart |

Password workspaces: if the outage also killed the ControlMaster, batch
reconnects fail `ssh.auth-failed` exactly 3× and escalate — the app
auto-reopens the password prompt with reconnect context; entering the
password reattaches to the same daemon (measured: 12s end-to-end,
claude TUI intact). Cancelling settles in disconnected without a retry
loop.

Caveats specific to `docker pause`:
- the daemon is frozen too, so its grace clock is effectively suspended
  while paused (CLOCK_MONOTONIC still advances; on unpause the watchdog
  races the reattach — for >300s outages prefer `docker network
  disconnect`, which keeps the container running, for faithful timing);
- frozen processes produce no output during the pause, so ring-buffer
  replay content under pause is thinner than a real outage would be.

Alternative injection methods, when pause is not faithful enough:
`docker network disconnect/connect` (removes the interface; caveat —
Docker Desktop's port proxy sits between host and container) or
`iptables -j DROP` inside the container (true packet blackhole; needs
`cap_add: [NET_ADMIN]` in compose).

## Tear down

```sh
docker compose down                 # stop + remove container
docker compose down --rmi local     # also remove the built image
```

## Known limits

- **arm64 only.** M1 native. To exercise cross-arch (the monolith2 path is
  linux/amd64), build manually with `--platform=linux/amd64` — qemu-emulated,
  slow, but verifies the binary distribution matrix.
- **Bind-mount ownership.** Files in `workspace-seed/` are owned by the host
  user. Docker Desktop on macOS reconciles this transparently for reads;
  writes from inside the container may need `chown` once Phase 5 (fs write
  over SSH) lands.
- **No macOS fixture.** Docker cannot run macOS. To test the macOS remote
  path, enable System Settings → General → Sharing → Remote Login on the host
  and `ssh localhost` instead.
- **No node/bun by design.** This proves the Phase 0 limitation (current TS
  server requires `bun` + repo checkout on the remote) is real. After the Go
  server ships, the same fixture confirms it runs with zero runtime deps.
  The pre-installed Claude Code binary is self-contained and does not
  weaken this guarantee (see "Claude Code in the fixture").
