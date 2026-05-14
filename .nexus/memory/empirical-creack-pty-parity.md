# empirical: creack/pty macOS parity

Date: 2026-05-14
Environment: macOS 26.3 (25D125), darwin/arm64, Go 1.24.3
Dependency under test: `github.com/creack/pty v1.1.24`

## Result

PASS — the required macOS PTY parity gate passed. This supports proceeding with the Go PTY replacement path; no required behavior failed in the spike.

## Scenarios verified

1. `pty.Setsize`/`TIOCSWINSZ` resize propagated to the child: a child-side `SIGWINCH` was observed and `GetsizeFull(os.Stdin)` reported the requested `41x132` geometry.
2. `pty.Start` gave the child controlling-terminal/session behavior: the child was its own session leader (`getsid(0) == pid`) and could open/write `/dev/tty`.
3. A child `SIGWINCH` handler ran on resize, independently of geometry assertions.
4. Writing raw `0x03` to the master delivered `SIGINT` through the terminal line discipline.
5. `cmd.Wait` preserved both normal exit code recovery (`exit 7`) and signal termination recovery (`SIGTERM` on `/bin/sleep`). The signal case uses a default-signal child because Go helper processes can mediate SIGTERM via the Go runtime.

## Commands

- `go test -count=1 ./internal/pty/...` → PASS
- `go test ./internal/...` → PASS

## Artifacts

- `internal/pty/creack_parity_darwin_test.go`
- `internal/pty/doc.go`
