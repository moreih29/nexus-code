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

## Follow-up assertions (T12)

- Remote resize: `pty.resize(120, 40)` → `stty size` inside remote shell reports `40 120`.
- Remote SIGINT: `trap 'exit 130' INT; sleep 30` interrupted by `\x03` → `pty.exit code=130` within 25 s.
- Channel kill: `ssh -O exit` (close ControlMaster) → channel emits `reconnecting` lifecycle event → `pty.exit code=null` exactly once.

## Output excerpt

```
$ __PWD__/home/nexus-dev/workspace
$ __UNAME__Linux 31b410291673 6.8.0-100-generic #100-Ubuntu SMP PREEMPT_DYNAMIC Tue Jan 13 16:39:21 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux
```

## Limitation

This validates the opt-in SSH password fixture path, not every user SSH auth mode or host OS.
