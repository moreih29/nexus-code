/**
 * Codex in NexusCode's terminals. An interactive codex runs its commands in a
 * shared background server, which keeps the environment of the terminal that
 * started it: perhaps one outside the app or another tab, where nexus is not
 * on PATH or answers for the wrong tab. In the app's terminals codex starts
 * with --no-daemon, which runs the server inside the session, with this
 * terminal's environment.
 *
 * The flag is left off for a codex without it, which would refuse it, and
 * for a command that refuses it or has no use for it (CODEX_SERVER_ARGS).
 * On macOS, Linux, an SSH host and Git Bash the wrapper below is `codex`, in
 * the directory the app puts first on PATH; PowerShell and cmd get theirs
 * from pty/windows-shell-shim.ts.
 */

/**
 * Arguments that start codex as it is: `agents` and `queue` need the shared
 * server, `--remote` (or `--remote=<addr>`) connects to another, the
 * server's own commands manage it, and `--no-daemon` is there already.
 */
export const CODEX_SERVER_ARGS = [
  "agents",
  "queue",
  "app-server",
  "remote-control",
  "--remote",
  "--no-daemon",
] as const;

/** The wrapper, for sh: the next codex on PATH, with --no-daemon in the app. */
export const CODEX_WRAPPER = `#!/bin/sh
# nexus-code codex wrapper: codex with --no-daemon in NexusCode's terminals,
# so that its commands run with this terminal's environment.
self_dir=\${NEXUS_WRAPPER_SELF_DIR:-$(cd "$(dirname "$0")" && pwd)}
real=
set -f
ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] && [ "$dir" != "$self_dir" ] || continue
  [ -f "$dir/codex" ] && [ -x "$dir/codex" ] || continue
  # Another copy of this wrapper.
  head -n 5 "$dir/codex" 2>/dev/null | grep -q 'nexus-code codex wrapper' && continue
  real=$dir/codex
  break
done
IFS=$ifs
set +f
if [ -z "$real" ]; then
  echo "codex: command not found" >&2
  exit 127
fi
if [ "\${NEXUS_IN_APP:-}" = 1 ]; then
  for arg in "$@"; do
    case $arg in
      ${CODEX_SERVER_ARGS.join(" | ")} | --remote=*) exec "$real" "$@" ;;
    esac
  done
  # A codex from before the option would refuse it.
  if "$real" --help 2>/dev/null | grep -qF -e --no-daemon; then
    exec "$real" --no-daemon "$@"
  fi
fi
exec "$real" "$@"
`;
