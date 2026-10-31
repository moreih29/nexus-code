/**
 * Claude Code's hooks in a local Windows terminal.
 *
 * On macOS and Linux the claude wrapper (scripts/assets/claude-wrapper.sh),
 * first on PATH, runs `claude` with the app's hooks, which report Claude's
 * status to the tab. Of the Windows shells only bash runs that script, so
 * each shell gets its `claude` its own way:
 *
 * - Git Bash: the wrapper itself, copied to ~/.nexus-code/bin, which the
 *   agent puts first on PATH in place of the nexus launchers' directory.
 * - PowerShell: a `claude` function, defined as the shell starts.
 * - cmd: a doskey macro.
 *
 * The last two hand claude the wrapper's hooks, kept in
 * ~/.nexus-code/claude-settings.json. Claude Code runs hook commands in Git
 * Bash on Windows too, so the wrapper's commands work as they are. Those
 * shells must not have ~/.nexus-code/bin on PATH: PowerShell takes the
 * wrapper there, a file without an extension, for the program `claude`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../../shared/log/main";
import { getAgentBinDir } from "../../infra/agent/getAgentBinDir";
import { binDir, ensureDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("pty");

/** Where `installWindowsClaudeFiles` put the wrapper and the hooks. */
export interface WindowsClaudeFiles {
  /** The directory of the wrapper copy, for Git Bash's PATH. */
  readonly binDir: string;
  /** The hooks settings file PowerShell and cmd pass to claude. */
  readonly settingsPath: string;
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

let installing: Promise<WindowsClaudeFiles | null> | undefined;

/**
 * Copies the wrapper to ~/.nexus-code/bin and writes its hooks to
 * ~/.nexus-code/claude-settings.json, once per run of the app. The copy
 * keeps Git Bash off the MSIX package's files, which a process outside the
 * package may not use. Null when that fails; the terminals then run claude
 * without hooks.
 */
export function installWindowsClaudeFiles(): Promise<WindowsClaudeFiles | null> {
  installing ??= (async () => {
    try {
      const wrapper = await fs.readFile(path.join(getAgentBinDir(), "claude"), "utf8");
      const settings = wrapperHooksSettings(wrapper);
      if (settings === null) throw new Error("the claude wrapper has no hooks settings");
      const dir = binDir();
      await ensureDir(dir);
      await fs.writeFile(path.join(dir, "claude"), wrapper);
      const settingsPath = path.join(root(), "claude-settings.json");
      await fs.writeFile(settingsPath, settings);
      return { binDir: dir, settingsPath };
    } catch (error) {
      log.warn(`claude hooks unavailable in Windows terminals: ${(error as Error).message}`);
      return null;
    }
  })();
  return installing;
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
  /** The directory of the wrapper's copy, which Git Bash runs as `claude`. */
  wrapperDir?: string;
  /** The ORIGINAL_PATH the shell inherits from the app, if any. */
  originalPath?: string;
}

export interface WindowsShellShimOutput {
  env: Record<string, string>;
  args?: string[];
}

/**
 * The environment and arguments that give the terminal's shell its claude
 * with hooks. Every shell keeps the nexus launchers first on PATH, but Git
 * Bash has the wrapper's directory there instead, which has a launcher of
 * its own. A shell started with its own command keeps it and gets no hooks.
 */
export function applyWindowsShellShim(input: WindowsShellShimInput): WindowsShellShimOutput {
  const { shell, args, settingsPath, wrapperDir } = input;
  const name = path.win32.basename(shell).toLowerCase();
  const isBash = name === "bash.exe" || name === "bash";
  // WSL's bash in System32 starts a Linux shell, where a Windows directory
  // on PATH is of no use.
  if (isBash && /[\\/]system32[\\/]/i.test(shell)) {
    const { NEXUS_WRAPPER_SELF_DIR: _launcherDir, ...env } = input.env;
    return { env, args };
  }
  const env = input.env;
  if (settingsPath === undefined) return { env, args };

  if (name === "powershell.exe" || name === "pwsh.exe" || name === "pwsh") {
    if (args?.some(isPowerShellCommand)) return { env, args };
    const encoded = Buffer.from(POWERSHELL_CLAUDE, "utf16le").toString("base64");
    return {
      env: { ...env, NEXUS_CLAUDE_SETTINGS: settingsPath },
      args: [...(args ?? []), "-NoExit", "-EncodedCommand", encoded],
    };
  }

  if (name === "cmd.exe") {
    if (args?.some((arg) => /^\/[ck]/i.test(arg))) return { env, args };
    // cmd expands the variable in the /k command. Written out, the quotes
    // around the path would reach cmd escaped for a program, which cmd
    // doesn't read. Inside the macro, `claude` is the program on PATH.
    return {
      env: { ...env, NEXUS_CMD_INIT: `doskey claude=claude --settings "${settingsPath}" $*` },
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
