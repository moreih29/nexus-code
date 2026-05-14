# empirical: SSH remote terminal round-trip

Date: 2026-05-14

## Fixture

- Host: nexus-dev@127.0.0.1:2223
- Remote workspace path: /home/nexus-dev/workspace
- Agent uploaded during run: no, existing artifact reused

## Result

- Remote OS: `Linux 31b410291673 6.8.0-100-generic #100-Ubuntu SMP PREEMPT_DYNAMIC Tue Jan 13 16:39:21 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux`
- `pwd` inside the PTY matched the remote workspace path: `/home/nexus-dev/workspace`
- `exit 0` produced PTY exit code `0`
- The `uname -a` output contains Linux and does not contain local Darwin, so the terminal was remote.

## Output excerpt

```
$ __PWD__/home/nexus-dev/workspace
$ __UNAME__Linux 31b410291673 6.8.0-100-generic #100-Ubuntu SMP PREEMPT_DYNAMIC Tue Jan 13 16:39:21 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux
```

## Limitation

This validates the opt-in SSH password fixture path, not every user SSH auth mode or host OS.

## Cleanup follow-up

The tester observed a possible production ControlMaster cleanup race during this cycle: unlinking the socket immediately after spawning `ssh -O exit` can race the master shutdown. The production disposer now waits for the exit helper `close`/`exit`/`error` event before unlinking, with a 5s fallback for a stuck helper. Verified with `bun test tests/unit/main/agent/ssh-channel.test.ts tests/integration/ssh/remote-terminal.integration.test.ts` and `NEXUS_RUN_SSH_PTY_FIXTURE=1 bun test tests/integration/ssh/`.
