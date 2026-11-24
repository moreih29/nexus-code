import fs from "node:fs/promises";
import path from "node:path";
import {
  CODEX_CMD_BATCH_HELP,
  CODEX_CMD_BATCH_HELP_FILE,
  CODEX_CMD_HELP,
  CODEX_CMD_HELP_FILE,
  CODEX_CMD_LAUNCHER,
  CODEX_POWERSHELL_PROBE,
  CODEX_SERVER_ARGS,
  CODEX_WRAPPER,
} from "../../../shared/codex/wrapper";
import { createLogger } from "../../../shared/log/main";
import { getAgentBinDir } from "../../infra/agent/getAgentBinDir";
import { binDir, ensureDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("pty");

export interface WindowsAgentFiles {
  readonly binDir: string;
  readonly settingsPath?: string;
  readonly serverlessSettingsPath?: string;
  readonly cmdLauncherDir?: string;
}

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

const SERVERLESS_HOOK_SUBCOMMANDS = new Set(["send-message"]);

interface HookGroup {
  readonly hooks?: readonly { readonly command?: unknown }[];
}

function runsWithoutServer(hook: { readonly command?: unknown }): boolean {
  const subcommand = /^"\$\{NEXUS_AGENT_BIN\}" hook ([a-z-]+)$/.exec(String(hook.command))?.[1];
  return subcommand !== undefined && SERVERLESS_HOOK_SUBCOMMANDS.has(subcommand);
}

export function serverlessHooksSettings(settings: string): string {
  const parsed = JSON.parse(settings) as { hooks?: Record<string, readonly HookGroup[]> };
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter(runsWithoutServer) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return JSON.stringify({ ...parsed, hooks });
}

let installing: Promise<WindowsAgentFiles | null> | undefined;

export function installWindowsAgentFiles(): Promise<WindowsAgentFiles | null> {
  installing ??= installFiles().then(
    (files) => {
      if (!files?.settingsPath || !files.cmdLauncherDir) installing = undefined;
      return files;
    },
    (error: unknown) => {
      installing = undefined;
      throw error;
    },
  );
  return installing;
}

async function installFiles(): Promise<WindowsAgentFiles | null> {
  const dir = binDir();
  try {
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, "codex"), CODEX_WRAPPER);
  } catch (error) {
    log.warn(`wrappers unavailable in Windows terminals: ${(error as Error).message}`);
    return null;
  }
  const [claude, cmdLauncherDir] = await Promise.all([
    installClaudeFiles(dir),
    installCmdLauncher(path.join(dir, "cmd")),
  ]);
  return { binDir: dir, ...claude, cmdLauncherDir };
}

async function installClaudeFiles(
  dir: string,
): Promise<Pick<WindowsAgentFiles, "settingsPath" | "serverlessSettingsPath">> {
  try {
    const wrapper = await fs.readFile(path.join(getAgentBinDir(), "claude"), "utf8");
    const settings = wrapperHooksSettings(wrapper);
    if (settings === null) throw new Error("the claude wrapper has no hooks settings");
    await fs.writeFile(path.join(dir, "claude"), wrapper);
    const settingsPath = path.join(root(), "claude-settings.json");
    const serverlessSettingsPath = path.join(root(), "claude-settings-serverless.json");
    await fs.writeFile(settingsPath, settings);
    await fs.writeFile(serverlessSettingsPath, serverlessHooksSettings(settings));
    return { settingsPath, serverlessSettingsPath };
  } catch (error) {
    log.warn(`claude hooks unavailable in Windows terminals: ${(error as Error).message}`);
    return {};
  }
}

async function installCmdLauncher(dir: string): Promise<string | undefined> {
  try {
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, CODEX_CMD_HELP_FILE), CODEX_CMD_HELP);
    await fs.writeFile(path.join(dir, CODEX_CMD_BATCH_HELP_FILE), CODEX_CMD_BATCH_HELP);
    await fs.writeFile(path.join(dir, "codex.cmd"), CODEX_CMD_LAUNCHER);
    return dir;
  } catch (error) {
    log.warn(`codex launcher unavailable in cmd: ${(error as Error).message}`);
    return undefined;
  }
}

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

const POWERSHELL_CODEX = `function global:codex {
  $real = Get-Command -Name codex -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $real) { Write-Error 'codex: command not found'; return }
  $flags = @()
  $server = $args | Where-Object { $_ -in @(${CODEX_SERVER_ARGS.map((arg) => `'${arg}'`).join(", ")}) -or "$_" -like '--remote=*' }
  ${CODEX_POWERSHELL_PROBE}
  if (-not $server -and (Test-NexusCodexNoDaemon $real.Source)) { $flags = , '--no-daemon' }
  if ($MyInvocation.ExpectingInput) { $input | & $real.Source @flags @args } else { & $real.Source @flags @args }
}`;

export interface WindowsShellShimInput {
  shell: string;
  env: Record<string, string>;
  args?: string[];
  settingsPath?: string;
  wrapperDir?: string;
  codex?: { readonly cmdLauncherDir?: string };
  originalPath?: string;
}

export interface WindowsShellShimOutput {
  env: Record<string, string>;
  args?: string[];
}

export function applyWindowsShellShim(input: WindowsShellShimInput): WindowsShellShimOutput {
  const shimmed = shimShell(input);
  const first = shimmed.env.NEXUS_WRAPPER_SELF_DIR;
  if (!input.originalPath || first === undefined) return shimmed;
  return { ...shimmed, env: { ...shimmed.env, ORIGINAL_PATH: `${first};${input.originalPath}` } };
}

function shimShell(input: WindowsShellShimInput): WindowsShellShimOutput {
  const { shell, args, settingsPath, wrapperDir, codex } = input;
  const name = path.win32.basename(shell).toLowerCase();
  const isBash = name === "bash.exe" || name === "bash";
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

function isPowerShellCommand(arg: string): boolean {
  if (!arg.startsWith("-")) return true;
  const name = arg.replace(/^-+/, "").split(":")[0]?.toLowerCase() ?? "";
  if (name === "ec") return true;
  return (
    name.length > 0 &&
    ["command", "file", "encodedcommand"].some((switchName) => switchName.startsWith(name))
  );
}
