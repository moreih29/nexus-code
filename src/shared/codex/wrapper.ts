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
 *
 * A `codex exec` run inside a tab's Claude session, as from its Bash tool or
 * a script it runs, runs under the agent (`agent exec-run`), which tells the
 * app of it as one of the session's agents, as it does a `claude -p` run
 * (claude-wrapper.sh). The app marks a terminal whose agent has exec-run
 * (NEXUS_AGENT_EXEC_RUN): an older agent, still named in a terminal an older
 * app started, would take the word for the directory to serve.
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

const CMD_LAUNCHER_MARK = "@rem nexus-code codex cmd launcher";
export const CODEX_CMD_HELP_FILE = "codex-help.ps1";
export const CODEX_CMD_BATCH_HELP_FILE = "codex-help.cmd";

/** The cmd probe preserves literal percent signs and turns delayed expansion off for Codex. */
export const CODEX_CMD_BATCH_HELP = [
  "@echo off",
  "setlocal EnableExtensions DisableDelayedExpansion",
  '"%nexus_codex_real%" --help',
  "",
].join("\r\n");

/**
 * Runs help in a separate process so a stalled npm shim or executable can't
 * hold the terminal. The same deadline covers the child and its output pipes.
 */
export const CODEX_POWERSHELL_PROBE = `function Test-NexusCodexNoDaemon {
  param([string]$Program, [string]$BatchHelper)
  $worker = @'
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
& $env:NEXUS_CODEX_PROBE_PROGRAM --help
exit $LASTEXITCODE
'@
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
  $start.FileName = Join-Path $PSHOME $shell
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($worker))
  $start.Arguments = "-NoProfile -NonInteractive -EncodedCommand $encoded"
  if ($BatchHelper) {
    $start.FileName = $env:ComSpec
    $start.Arguments = '/d /v:on /s /c ""!NEXUS_CODEX_PROBE_HELPER!""'
    $start.EnvironmentVariables['NEXUS_CODEX_PROBE_HELPER'] = $BatchHelper
  }
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['NEXUS_CODEX_PROBE_PROGRAM'] = $Program
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = $null
  try {
    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $left = [Math]::Max(0, 3000 - $clock.ElapsedMilliseconds)
    if (-not $process.WaitForExit([int]$left)) { return $false }
    $left = [Math]::Max(0, 3000 - $clock.ElapsedMilliseconds)
    $pipes = [Threading.Tasks.Task[]]@($output, $errors)
    if (-not [Threading.Tasks.Task]::WaitAll($pipes, [int]$left)) { return $false }
    return ($process.ExitCode -eq 0 -and $output.Result.Contains('--no-daemon'))
  } catch {
    return $false
  } finally {
    if ($process) {
      if (-not $process.HasExited) {
        try {
          $kill = New-Object System.Diagnostics.ProcessStartInfo
          $kill.FileName = Join-Path $env:SystemRoot 'System32\\taskkill.exe'
          $kill.Arguments = "/PID $($process.Id) /T /F"
          $kill.UseShellExecute = $false
          $kill.CreateNoWindow = $true
          $kill.RedirectStandardOutput = $true
          $kill.RedirectStandardError = $true
          [Diagnostics.Process]::Start($kill).Dispose()
        } catch {}
      }
      $process.Dispose()
    }
  }
}`;

/** The cmd launcher takes the PowerShell probe's result from its exit status. */
export const CODEX_CMD_HELP = `${CODEX_POWERSHELL_PROBE}
if (Test-NexusCodexNoDaemon $env:nexus_codex_real (Join-Path $PSScriptRoot '${CODEX_CMD_BATCH_HELP_FILE}')) { exit 0 }
exit 1
`;

/** A cmd launcher that dispatches to the first real Codex on PATH. */
export const CODEX_CMD_LAUNCHER = [
  CMD_LAUNCHER_MARK,
  "@echo off",
  "setlocal EnableExtensions DisableDelayedExpansion",
  'set "nexus_codex_real="',
  // Keep paths quoted, with delayed expansion off for literal ! characters.
  'for /f "delims=" %%I in (\'"%SystemRoot%\\System32\\where.exe" codex 2^>nul\') do (',
  '  if /i not "%%~fI"=="%~f0" (',
  '    set "nexus_codex_copy="',
  '    if /i "%%~xI"==".cmd" (',
  `      "%SystemRoot%\\System32\\findstr.exe" /b /l /c:"${CMD_LAUNCHER_MARK}" "%%~fI" >nul 2>&1`,
  '      if not errorlevel 1 set "nexus_codex_copy=1"',
  "    )",
  "    if not defined nexus_codex_copy (",
  '      set "nexus_codex_real=%%~fI"',
  "      goto :scan",
  "    )",
  "  )",
  ")",
  "echo codex: command not found 1>&2",
  "exit /b 127",
  ":scan",
  'set "nexus_codex_arg=%~1"',
  "if defined nexus_codex_arg goto :classify",
  'if "%1"=="" goto :probe',
  "goto :next",
  ":classify",
  "setlocal EnableDelayedExpansion",
  ...CODEX_SERVER_ARGS.map((arg) => `if /i "!nexus_codex_arg!"=="${arg}" goto :unchanged`),
  'if /i "!nexus_codex_arg:~0,9!"=="--remote=" goto :unchanged',
  "endlocal",
  ":next",
  "shift /1",
  "goto :scan",
  ":unchanged",
  "endlocal",
  "goto :plain",
  ":probe",
  `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${CODEX_CMD_HELP_FILE}" >nul 2>&1`,
  "if errorlevel 1 goto :plain",
  // SHIFT preserves %*. Direct invocation preserves the raw argument list
  // and lets an npm .cmd launcher take over with its own exit status.
  '"%nexus_codex_real%" --no-daemon %*',
  "exit /b %errorlevel%",
  ":plain",
  '"%nexus_codex_real%" %*',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

/**
 * codex's options that take a value as the next argument, which the wrapper
 * steps over to find the command (hookclient's codexValueOptions).
 */
export const CODEX_VALUE_OPTIONS = [
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
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
# Whether the arguments run \`codex exec\` (or \`e\`): the first that is
# neither an option nor an option's value.
is_exec() {
  value=
  for arg in "$@"; do
    if [ -n "$value" ]; then
      value=
      continue
    fi
    case $arg in
      --) return 1 ;;
      ${CODEX_VALUE_OPTIONS.join(" | ")}) value=1 ;;
      -*) ;;
      exec | e) return 0 ;;
      *) return 1 ;;
    esac
  done
  return 1
}
if [ "\${NEXUS_IN_APP:-}" = 1 ]; then
  for arg in "$@"; do
    case $arg in
      ${CODEX_SERVER_ARGS.join(" | ")} | --remote=*) exec "$real" "$@" ;;
    esac
  done
  # A codex from before the option would refuse it.
  if "$real" --help 2>/dev/null | grep -qF -e --no-daemon; then
    set -- --no-daemon "$@"
  fi
  # A \`codex exec\` inside the tab's Claude session runs under the agent.
  if [ -n "\${NEXUS_TAB_ID:-}" ] && [ "\${NEXUS_CLAUDE_TAB_ID:-}" = "$NEXUS_TAB_ID" ] &&
    [ "\${NEXUS_AGENT_EXEC_RUN:-}" = 1 ] && [ -n "\${NEXUS_AGENT_BIN:-}" ] &&
    [ -x "$NEXUS_AGENT_BIN" ] && is_exec "$@"; then
    exec "$NEXUS_AGENT_BIN" exec-run "$real" "$@"
  fi
fi
exec "$real" "$@"
`;
