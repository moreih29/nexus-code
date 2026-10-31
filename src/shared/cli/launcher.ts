/**
 * The nexus command itself: a launcher that runs `agent cli <args>`. It
 * sits in the directory the app puts first on its terminals' PATH —
 * dist/agent/bin on macOS and Linux, ~/.nexus-code/bin on an SSH host, and
 * on Windows a directory of its own (see main/features/cli/launchers.ts).
 */

/** The launcher for sh, which finds the agent through the terminal's environment. */
export const POSIX_CLI_LAUNCHER = `#!/bin/sh
# nexus-code CLI launcher: the nexus command in NexusCode's terminals.
if [ -z "\${NEXUS_AGENT_BIN:-}" ]; then
  echo "nexus: run this in a NexusCode terminal" >&2
  exit 2
fi
exec "$NEXUS_AGENT_BIN" cli "$@"
`;

/**
 * The Windows launchers, for cmd and PowerShell (nexus.cmd) and for Git
 * Bash (nexus), running `agentCommand`: the agent, or the MSIX package's
 * alias for it, which is the only way a shell may start the package's files.
 */
export function windowsCliLaunchers(agentCommand: string): { cmd: string; sh: string } {
  return {
    cmd: `@echo off\r\n"${agentCommand}" cli %*\r\n`,
    sh: `#!/bin/sh\nexec '${agentCommand.replaceAll("'", "'\\''")}' cli "$@"\n`,
  };
}
