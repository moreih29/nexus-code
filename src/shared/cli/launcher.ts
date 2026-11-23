export const POSIX_CLI_LAUNCHER = `#!/bin/sh
# nexus-code CLI launcher: the nexus command in NexusCode's terminals.
if [ -z "\${NEXUS_AGENT_BIN:-}" ]; then
  echo "nexus: run this in a NexusCode terminal" >&2
  exit 2
fi
exec "$NEXUS_AGENT_BIN" cli "$@"
`;

export function cliExecutableName(agentName: string): string {
  return agentName.replace(/^agent-/, "nexus-");
}

export function windowsGitBashLauncher(program: string): string {
  return `#!/bin/sh
NEXUS_MSYS_ROOT=$(cygpath -w / 2>/dev/null)
export NEXUS_MSYS_ROOT
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
exec '${program.replaceAll("'", "'\\''")}' "$@"
`;
}
