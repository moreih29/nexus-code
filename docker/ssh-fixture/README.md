# SSH test fixture

Docker-based SSH server for verifying the SSH remote workspace path
(`feat/ssh-remote-workspace`). Two Ubuntu 22.04 arm64 containers — one
key-auth (`127.0.0.1:2222`), one password-auth (`127.0.0.1:2223`) —
no node/bun/python on the remote, by design.

## Layout

```
docker/ssh-fixture/
├── Dockerfile           # ubuntu:22.04 + openssh-server + git + ripgrep
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
