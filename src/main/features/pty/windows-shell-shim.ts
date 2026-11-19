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
 * - cmd: a Claude doskey macro and a codex.cmd launcher on PATH.
 *
 * The last two hand claude the wrapper's hooks, kept in
 * ~/.nexus-code/claude-settings.json. Claude Code runs hook commands in Git
 * Bash on Windows too, so the wrapper's commands work as they are. Those
 * shells must not have ~/.nexus-code/bin on PATH: PowerShell takes a
 * wrapper there, a file without an extension, for the program.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  CODEX_CMD_HELP,
  CODEX_CMD_HELP_FILE,
  CODEX_CMD_LAUNCHER,
  CODEX_SERVER_ARGS,
  CODEX_WRAPPER,
} from "../../../shared/codex/wrapper";
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
  /** The directory containing codex.cmd, added to cmd's PATH. */
  readonly cmdLauncherDir?: string;
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
    const [settingsPath, cmdLauncherDir] = await Promise.all([
      installClaudeFiles(dir),
      installCmdLauncher(path.join(dir, "cmd")),
    ]);
    return { binDir: dir, settingsPath, cmdLauncherDir };
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

/** Installs the launcher in a directory used only by cmd terminals. */
async function installCmdLauncher(dir: string): Promise<string | undefined> {
  try {
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, CODEX_CMD_HELP_FILE), CODEX_CMD_HELP);
    await fs.writeFile(path.join(dir, "codex.cmd"), CODEX_CMD_LAUNCHER);
    return dir;
  } catch (error) {
    log.warn(`codex launcher unavailable in cmd: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * PowerShell's `claude`: the first claude program on PATH, with the hooks
 * when their file is there, and any pipeline input passed on. It carries
 * the wrapper's marks while it runs: the tab's id, so a claude started
 * inside its session, by its Bash tool through the wrapper, goes without
 * the tab's hooks, and whether it is a `claude -p` run, whose permission
 * requests no dialog answers. (PowerShell keeps `--` from a function's
 * arguments.)
 */
const POWERSHELL_CLAUDE = `function global:claude {
  $real = Get-Command -Name claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $real) { Write-Error 'claude: command not found'; return }
  $hooks = @()
  if ($env:NEXUS_CLAUDE_SETTINGS -and (Test-Path -LiteralPath $env:NEXUS_CLAUDE_SETTINGS -ErrorAction SilentlyContinue)) {
    $hooks = '--settings', $env:NEXUS_CLAUDE_SETTINGS
  }
  $marks = $env:NEXUS_CLAUDE_TAB_ID, $env:NEXUS_CLAUDE_PRINT
  $env:NEXUS_CLAUDE_TAB_ID = $env:NEXUS_TAB_ID
  $env:NEXUS_CLAUDE_PRINT = if ($args | Where-Object { "$_" -in @('-p', '--print') }) { '1' } else { '0' }
  try {
    if ($MyInvocation.ExpectingInput) { $input | & $real.Source @hooks @args } else { & $real.Source @hooks @args }
  } finally {
    $env:NEXUS_CLAUDE_TAB_ID, $env:NEXUS_CLAUDE_PRINT = $marks
  }
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
   * Installs PowerShell's codex function and enables the cmd launcher when
   * its directory is available.
   */
  codex?: { readonly cmdLauncherDir?: string };
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
  const shimmed = shimShell(input);
  // Git Bash's login profile builds PATH from ORIGINAL_PATH when it is set,
  // as it is in an app started from Git Bash, and would drop the directory
  // the agent puts first on PATH. It goes first there too, for the terminal's
  // Git Bash and for one started from PowerShell or cmd, such as Claude
  // Code's Bash tool.
  const first = shimmed.env.NEXUS_WRAPPER_SELF_DIR;
  if (!input.originalPath || first === undefined) return shimmed;
  return { ...shimmed, env: { ...shimmed.env, ORIGINAL_PATH: `${first};${input.originalPath}` } };
}

function shimShell(input: WindowsShellShimInput): WindowsShellShimOutput {
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
    const cmdEnv = codex?.cmdLauncherDir
      ? { ...env, NEXUS_CMD_CODEX_DIR: codex.cmdLauncherDir }
      : env;
    if (settingsPath === undefined) return { env: cmdEnv, args };
    // cmd expands the variable in the /k command. Written out, the quotes around the path would reach
    // cmd escaped for a program, which cmd doesn't read. Inside a macro,
    // claude is the program on PATH, and its `-p` mark is left to the
    // hook client (internal/hookclient). claude carries the tab's mark
    // while it runs, as PowerShell's does: the escaped `&` joins the
    // commands of the macro, and its %NEXUS_TAB_ID% is expanded as it runs.
    // cmd expands a macro only as a line's first word: `cd x & claude` or a
    // .bat's claude runs without the settings, its hooks and all (docs/CLI.md).
    const macro = `doskey claude=set "NEXUS_CLAUDE_TAB_ID=%NEXUS_TAB_ID%" ^& claude --settings "${settingsPath}" $* ^& set "NEXUS_CLAUDE_TAB_ID="`;
    return {
      env: { ...cmdEnv, NEXUS_CMD_INIT: macro },
      args: [...(args ?? []), "/k", "%NEXUS_CMD_INIT%"],
    };
  }

  if (isBash && wrapperDir !== undefined) {
    return { env: { ...env, NEXUS_WRAPPER_SELF_DIR: wrapperDir }, args };
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
