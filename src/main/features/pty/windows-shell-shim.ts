/**
 * Claude Code's hooks and Codex's --no-daemon in a local Windows terminal.
 *
 * On macOS and Linux the claude wrapper (scripts/assets/claude-wrapper.sh),
 * first on PATH, runs `claude` with the app's hooks, which report Claude's
 * status to the tab, and the codex wrapper (shared/codex/wrapper.ts) runs
 * `codex` with --no-daemon. Of the Windows shells only bash runs those
 * scripts, so each shell gets its `claude` and `codex` its own way:
 *
 * - Git Bash: the wrappers themselves, copied to ~/.nexus-code/bin, which
 *   the agent puts first on PATH in place of the nexus launchers' directory.
 * - PowerShell: `claude` and `codex` functions, defined as the shell starts.
 * - cmd: doskey macros.
 *
 * The last two hand claude the wrapper's hooks, kept in
 * ~/.nexus-code/claude-settings.json. Claude Code runs hook commands in Git
 * Bash on Windows too, so the wrapper's commands work as they are. Those
 * shells must not have ~/.nexus-code/bin on PATH: PowerShell takes a
 * wrapper there, a file without an extension, for the program.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_SERVER_ARGS, CODEX_WRAPPER } from "../../../shared/codex/wrapper";
import { createLogger } from "../../../shared/log/main";
import { getAgentBinDir } from "../../infra/agent/getAgentBinDir";
import { binDir, ensureDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("pty");

/** Where `installWindowsAgentFiles` put the wrappers and the hooks. */
export interface WindowsAgentFiles {
  /** The directory of the wrapper copies, for Git Bash's PATH. */
  readonly binDir: string;
  /** The hooks settings file PowerShell and cmd pass to claude, if written. */
  readonly settingsPath?: string;
  /** Whether the codex cmd finds takes --no-daemon. */
  readonly cmdCodexNoDaemon: boolean;
}

/**
 * The settings JSON the wrapper writes for claude, read from the wrapper's
 * text, or null when it has none.
 */
export function wrapperHooksSettings(wrapper: string): string | null {
  const match = /<<'SETTINGS_EOF'\r?\n([\s\S]*?)\r?\nSETTINGS_EOF\r?\n/.exec(wrapper);
  if (!match?.[1]) return null;
  try {
    JSON.parse(match[1]);
  } catch {
    return null;
  }
  return match[1];
}

let installing: Promise<WindowsAgentFiles | null> | undefined;

/**
 * Copies the wrappers to ~/.nexus-code/bin and writes claude's hooks to
 * ~/.nexus-code/claude-settings.json, once per run of the app. The copies
 * keep Git Bash off the MSIX package's files, which a process outside the
 * package may not use. Null when the directory can't be written; the
 * terminals then run claude and codex as they are.
 */
export function installWindowsAgentFiles(): Promise<WindowsAgentFiles | null> {
  installing ??= (async () => {
    const dir = binDir();
    try {
      await ensureDir(dir);
      await fs.writeFile(path.join(dir, "codex"), CODEX_WRAPPER);
    } catch (error) {
      log.warn(`wrappers unavailable in Windows terminals: ${(error as Error).message}`);
      return null;
    }
    const [settingsPath, cmdCodexNoDaemon] = await Promise.all([
      installClaudeFiles(dir),
      cmdCodexTakesNoDaemon(),
    ]);
    return { binDir: dir, settingsPath, cmdCodexNoDaemon };
  })();
  return installing;
}

/** Copies the claude wrapper to `dir` and writes its hooks; their file, if written. */
async function installClaudeFiles(dir: string): Promise<string | undefined> {
  try {
    const wrapper = await fs.readFile(path.join(getAgentBinDir(), "claude"), "utf8");
    const settings = wrapperHooksSettings(wrapper);
    if (settings === null) throw new Error("the claude wrapper has no hooks settings");
    await fs.writeFile(path.join(dir, "claude"), wrapper);
    const settingsPath = path.join(root(), "claude-settings.json");
    await fs.writeFile(settingsPath, settings);
    return settingsPath;
  } catch (error) {
    log.warn(`claude hooks unavailable in Windows terminals: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Whether the codex on PATH, as cmd finds it, has --no-daemon. A doskey
 * macro can't ask at each run, as the wrapper and the PowerShell function
 * do, so cmd's terminals go by what it had when the app started.
 */
function cmdCodexTakesNoDaemon(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "cmd.exe",
      ["/d", "/s", "/c", "codex --help"],
      { windowsHide: true, timeout: 5000 },
      (_error, stdout) => resolve(String(stdout).includes("--no-daemon")),
    );
  });
}

/**
 * PowerShell's `claude`: the first claude program on PATH, with the hooks
 * when their file is there, and any pipeline input passed on.
 */
const POWERSHELL_CLAUDE = `function global:claude {
  $real = Get-Command -Name claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $real) { Write-Error 'claude: command not found'; return }
  $hooks = @()
  if ($env:NEXUS_CLAUDE_SETTINGS -and (Test-Path -LiteralPath $env:NEXUS_CLAUDE_SETTINGS -ErrorAction SilentlyContinue)) {
    $hooks = '--settings', $env:NEXUS_CLAUDE_SETTINGS
  }
  if ($MyInvocation.ExpectingInput) { $input | & $real.Source @hooks @args } else { & $real.Source @hooks @args }
}`;

/**
 * PowerShell's `codex`: the codex PowerShell would run, with --no-daemon
 * when it has the option and the command can do without the shared server
 * (see shared/codex/wrapper.ts).
 */
const POWERSHELL_CODEX = `function global:codex {
  $real = Get-Command -Name codex -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $real) { Write-Error 'codex: command not found'; return }
  $flags = @()
  $server = $args | Where-Object { $_ -in @(${CODEX_SERVER_ARGS.map((arg) => `'${arg}'`).join(", ")}) -or "$_" -like '--remote=*' }
  if (-not $server -and ((& $real.Source --help 2>$null) -match '--no-daemon')) { $flags = , '--no-daemon' }
  if ($MyInvocation.ExpectingInput) { $input | & $real.Source @flags @args } else { & $real.Source @flags @args }
}`;

export interface WindowsShellShimInput {
  /** The shell program the terminal starts. */
  shell: string;
  /**
   * The terminal's environment, with the app's NEXUS_* variables:
   * NEXUS_WRAPPER_SELF_DIR is the nexus launchers' directory.
   */
  env: Record<string, string>;
  /** The shell's arguments. */
  args?: string[];
  /** The hooks settings file; without one, no shell gets hooks. */
  settingsPath?: string;
  /** The directory of the wrappers' copies, which Git Bash runs as `claude` and `codex`. */
  wrapperDir?: string;
  /**
   * Codex's --no-daemon: PowerShell's function, and with `cmd` cmd's macro
   * too. Without it codex is left as it is.
   */
  codex?: { readonly cmd: boolean };
  /** The ORIGINAL_PATH the shell inherits from the app, if any. */
  originalPath?: string;
}

export interface WindowsShellShimOutput {
  env: Record<string, string>;
  args?: string[];
}

/**
 * The environment and arguments that give the terminal's shell its claude
 * with hooks and its codex with --no-daemon. Every shell keeps the nexus
 * launchers first on PATH, but Git Bash has the wrappers' directory there
 * instead, which has a launcher of its own. A shell started with its own
 * command keeps it and gets neither.
 */
export function applyWindowsShellShim(input: WindowsShellShimInput): WindowsShellShimOutput {
  const { shell, args, settingsPath, wrapperDir, codex } = input;
  const name = path.win32.basename(shell).toLowerCase();
  const isBash = name === "bash.exe" || name === "bash";
  // WSL's bash in System32 starts a Linux shell, where a Windows directory
  // on PATH is of no use.
  if (isBash && /[\\/]system32[\\/]/i.test(shell)) {
    const { NEXUS_WRAPPER_SELF_DIR: _launcherDir, ...env } = input.env;
    return { env, args };
  }
  const env = input.env;

  if (name === "powershell.exe" || name === "pwsh.exe" || name === "pwsh") {
    if (args?.some(isPowerShellCommand)) return { env, args };
    const functions = [
      ...(settingsPath !== undefined ? [POWERSHELL_CLAUDE] : []),
      ...(codex !== undefined ? [POWERSHELL_CODEX] : []),
    ];
    if (functions.length === 0) return { env, args };
    const encoded = Buffer.from(functions.join("\n"), "utf16le").toString("base64");
    return {
      env: settingsPath !== undefined ? { ...env, NEXUS_CLAUDE_SETTINGS: settingsPath } : env,
      args: [...(args ?? []), "-NoExit", "-EncodedCommand", encoded],
    };
  }

  if (name === "cmd.exe") {
    if (args?.some((arg) => /^\/[ck]/i.test(arg))) return { env, args };
    // cmd expands the variable in the /k command, and runs each macro's
    // doskey in turn. Written out, the quotes around the path would reach
    // cmd escaped for a program, which cmd doesn't read. Inside a macro,
    // `claude` and `codex` are the programs on PATH. A macro can't look at
    // its arguments, so codex in cmd takes --no-daemon for `agents` and
    // `queue` too, which refuse it.
    const macros = [
      ...(settingsPath !== undefined ? [`doskey claude=claude --settings "${settingsPath}" $*`] : []),
      ...(codex?.cmd ? ["doskey codex=codex --no-daemon $*"] : []),
    ];
    if (macros.length === 0) return { env, args };
    return {
      env: { ...env, NEXUS_CMD_INIT: macros.join(" & ") },
      args: [...(args ?? []), "/k", "%NEXUS_CMD_INIT%"],
    };
  }

  if (isBash && wrapperDir !== undefined) {
    // Git Bash's login profile builds PATH from ORIGINAL_PATH when it is set,
    // as it is in an app started from Git Bash, and would drop the wrapper
    // the agent put first on PATH: the wrapper goes first there too.
    const bashEnv: Record<string, string> = { ...env, NEXUS_WRAPPER_SELF_DIR: wrapperDir };
    if (input.originalPath) bashEnv.ORIGINAL_PATH = `${wrapperDir};${input.originalPath}`;
    return { env: bashEnv, args };
  }
  return { env, args };
}

/**
 * Whether a PowerShell argument gives the shell something to run: a script
 * (any argument that isn't a switch) or a -Command, -File or
 * -EncodedCommand switch, which PowerShell takes by any prefix (and the last
 * as -ec).
 */
function isPowerShellCommand(arg: string): boolean {
  if (!arg.startsWith("-")) return true;
  const name = arg.replace(/^-+/, "").split(":")[0]?.toLowerCase() ?? "";
  if (name === "ec") return true;
  return (
    name.length > 0 &&
    ["command", "file", "encodedcommand"].some((switchName) => switchName.startsWith(name))
  );
}
