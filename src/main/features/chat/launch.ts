import { gte, valid } from "semver";
import { injectHarnessTerminalEnv } from "../pty/harness-env";

export function claudeTabPrompt(instructions: string): string {
  return [CLAUDE_TAB_PROMPT, instructions].filter(Boolean).join("\n\n");
}

export const CLAUDE_TAB_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
  "--replay-user-messages",
  "--allow-dangerously-skip-permissions",
];

export const CLAUDE_TAB_PROMPT =
  "You are running in a chat tab of NexusCode, which shows a file your reply links as a card the user opens. Whenever you point the user at a file on the machine you run on (one you made, changed, read or found), write it as a markdown link to its path, as [greet.ts](src/greet.ts) or [report.md](/abs/path/report.md), not in backticks. A file elsewhere, as on a server you reach over ssh, stays in backticks: the user cannot open it.";

export const THINKING_DISPLAY_FROM = "2.1.94";

export function takesThinkingDisplay(version: string | null): boolean {
  return version !== null && valid(version) !== null && gte(version, THINKING_DISPLAY_FROM);
}

export const APPEND_PROMPT_FILE_FROM = "2.1.69";

export function takesAppendPromptFile(version: string | null): boolean {
  return version !== null && valid(version) !== null && gte(version, APPEND_PROMPT_FILE_FROM);
}

export const WINDOWS_COMMAND_LINE_MAX = 32_766;

export function escapeWindowsArg(arg: string): string {
  if (arg === "") return '""';
  let needsQuotes = false;
  let out = "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      out += ch;
      continue;
    }
    if (ch === '"') {
      out += `${"\\".repeat(backslashes + 1)}"`;
    } else {
      out += ch;
    }
    if (ch === " " || ch === "	") needsQuotes = true;
    backslashes = 0;
  }
  if (!needsQuotes) return out;
  return `"${out}${"\\".repeat(backslashes)}"`;
}

export function windowsCommandLineLength(program: string, args: readonly string[]): number {
  return [program, ...args].map(escapeWindowsArg).join(" ").length;
}

export function windowsCommandLineTooLong(program: string, args: readonly string[]): boolean {
  return windowsCommandLineLength(program, args) > WINDOWS_COMMAND_LINE_MAX;
}

export interface ResumeOptions {
  readonly resume?: string;
  readonly fork?: boolean;
  readonly resumeAt?: string;
  readonly resetLog?: boolean;
  readonly connectionChanged?: boolean;
  readonly usageOnly?: boolean;
}

export function claudeTabArgs(
  options: ResumeOptions,
  hooksSettings?: string,
  version: string | null = null,
  instructions = "",
  promptFile?: string,
): string[] {
  if (options.usageOnly) {
    return [
      ...CLAUDE_TAB_ARGS,
      "--no-session-persistence",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
    ];
  }
  const args = [
    ...CLAUDE_TAB_ARGS,
    ...(promptFile === undefined
      ? ["--append-system-prompt", claudeTabPrompt(instructions)]
      : ["--append-system-prompt-file", promptFile]),
  ];
  if (hooksSettings !== undefined) args.unshift("--settings", hooksSettings);
  if (takesThinkingDisplay(version)) args.push("--thinking-display", "summarized");
  if (options.resume !== undefined) {
    args.push("--resume", options.resume);
    if (options.fork) {
      args.push("--fork-session");
      if (options.resumeAt !== undefined) args.push("--resume-session-at", options.resumeAt);
    }
  }
  return args;
}

export interface ChatTabEnvContext {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly path?: string;
  readonly wrapperBinDir: string | null;
  readonly agentBin: string | null;
  readonly agentSocket?: string;
  readonly hookToken?: string;
}

export interface ClaudeTabEnvContext extends ChatTabEnvContext {
  readonly withoutWrapper?: boolean;
  readonly gitBash?: { readonly wrapperDir: string; readonly bashEnv: string };
}

export function gitBashPath(windowsPath: string): string {
  const slashed = windowsPath.replaceAll("\\", "/");
  return /^[A-Za-z]:/.test(slashed) ? `/${slashed[0]?.toLowerCase()}${slashed.slice(2)}` : slashed;
}

function chatTabBaseEnv(context: ChatTabEnvContext): Record<string, string> {
  const env =
    context.wrapperBinDir !== null
      ? injectHarnessTerminalEnv(undefined, {
          binDir: context.wrapperBinDir,
          workspaceId: context.workspaceId,
          tabId: context.tabId,
          agentBin: context.agentBin ?? undefined,
          agentSocket: context.agentSocket,
          hookToken: context.hookToken,
        })
      : {};
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  if (context.path !== undefined && context.path !== "") env.PATH = context.path;
  return env;
}

export function claudeTabEnv(context: ClaudeTabEnvContext): Record<string, string> {
  const env = chatTabBaseEnv(context);
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";
  if (context.withoutWrapper) {
    env.NEXUS_CLAUDE_TAB_ID = context.tabId;
    env.NEXUS_CLAUDE_PRINT = "1";
  }
  if (context.gitBash) {
    env.BASH_ENV = gitBashPath(context.gitBash.bashEnv);
    env.NEXUS_BASH_WRAPPER_DIR = gitBashPath(context.gitBash.wrapperDir);
  }
  return env;
}

export interface CodexTabEnvContext extends ChatTabEnvContext {
  readonly shimDir: string | null;
}

export function codexTabEnv(context: CodexTabEnvContext): Record<string, string> {
  const env = chatTabBaseEnv(context);
  env.NEXUS_CLAUDE_TAB_ID = context.tabId;
  if (context.wrapperBinDir !== null && context.shimDir !== null) {
    env.ZDOTDIR = context.shimDir;
    env.NEXUS_USER_ZDOTDIR = "";
    env.BASH_ENV = hostJoin(context.shimDir, "bashenv", false);
  }
  return env;
}

export type PluginAction = "install" | "enable" | "disable" | "update" | "uninstall";

export type ClaudeCommand =
  | { kind: "agents" }
  | { kind: "background"; sessionId?: string; model?: string; prompt?: string }
  | { kind: "stop"; id: string }
  | { kind: "plugins" }
  | { kind: "configUsage" }
  | { kind: "plugin"; action: PluginAction; plugin: string; scope?: "user" | "project" | "local" };

export function claudeCommandArgs(command: ClaudeCommand, cwd: string): string[] {
  switch (command.kind) {
    case "agents":
      return ["agents", "--json", "--all", "--cwd", cwd];
    case "background": {
      const args = ["--bg"];
      if (command.sessionId !== undefined) args.push("--resume", command.sessionId);
      if (command.model !== undefined) args.push("--model", command.model);
      if (command.prompt) args.push("--", command.prompt);
      return args;
    }
    case "stop":
      return ["stop", command.id];
    case "plugins":
      return ["plugin", "list", "--json"];
    case "configUsage":
      return [
        "-p",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--settings",
        '{"disableAllHooks":true}',
        "--output-format",
        "json",
        "/config",
      ];
    case "plugin": {
      const args = ["plugin", command.action, command.plugin, "--json"];
      if (command.scope !== undefined) args.push("--scope", command.scope);
      if (command.action === "uninstall") args.push("--keep-data");
      return args;
    }
  }
}

export function parseClaudeVersion(output: string): string | null {
  for (const line of output.split("\n")) {
    const match =
      /^(?:(?:codex(?:-cli)?|claude(?:-code)?)\s+)?(\d+\.\d+\.\d+)(?:[-+][\w.+-]+)?(?:\s+\(Claude Code\))?$/i.exec(
        line.trim(),
      );
    if (match) return match[1] ?? null;
  }
  return null;
}

export function hostJoin(dir: string, name: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}
