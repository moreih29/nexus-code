/**
 * The nexus command itself. On macOS, Linux and an SSH host it is a launcher
 * that runs `agent cli <args>`, in the directory the app puts first on its
 * terminals' PATH: dist/agent/bin, or ~/.nexus-code/bin on the host. On
 * Windows it is nexus.exe, the CLI client built on its own, in a directory
 * of its own (see main/features/cli/launchers.ts).
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

/** nexus.exe's name in the agent's distribution, from the agent binary's beside it. */
export function cliExecutableName(agentName: string): string {
  return agentName.replace(/^agent-/, "nexus-");
}

/**
 * The launcher Git Bash runs as `nexus`, running `program`, nexus.exe. On
 * its way to a Windows program Git Bash rewrites an argument that looks like
 * a path, making "/review" "C:/Program Files/Git/review"; the launcher turns
 * that off and tells nexus where "/" is, so the app reads the paths itself.
 */
export function windowsGitBashLauncher(program: string): string {
  return `#!/bin/sh
NEXUS_MSYS_ROOT=$(cygpath -w / 2>/dev/null)
export NEXUS_MSYS_ROOT
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
exec '${program.replaceAll("'", "'\\''")}' "$@"
`;
}
