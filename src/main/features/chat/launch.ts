// How a Claude tab's program is started: `claude -p` in stream-json mode,
// with the tab's marks and the hooks a terminal's claude gets. A Codex tab's
// `codex app-server` gets the same marks.

import { MANAGER_PROMPT } from "../../../shared/manager/prompt";
import { injectHarnessTerminalEnv } from "../pty/harness-env";

/** The arguments every Claude tab runs `claude` with. */
export const CLAUDE_TAB_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  // Permission requests come to the app as can_use_tool control requests.
  "--permission-prompt-tool",
  "stdio",
  // User messages come back once Claude has taken them, with their uuids.
  "--replay-user-messages",
  // Makes "권한 무시" selectable mid-session; without it set_permission_mode
  // bypassPermissions is refused. It does not switch the mode on.
  "--allow-dangerously-skip-permissions",
];

/**
 * What every Claude tab's claude is told on top of its own system prompt.
 * A reply's paths look alike whether it mentions one or means the user to
 * open it, so the tab shows a file as a card only when the reply links it
 * (or a tool of the session's took it).
 */
export const CLAUDE_TAB_PROMPT =
  "You are running in a chat tab of NexusCode, which shows a file your reply links as a card the user opens. Whenever you point the user at a file on the machine you run on (one you made, changed, read or found), write it as a markdown link to its path, as [greet.ts](src/greet.ts) or [report.md](/abs/path/report.md), not in backticks. A file elsewhere, as on a server you reach over ssh, stays in backticks: the user cannot open it.";

export interface ResumeOptions {
  readonly resume?: string;
  readonly fork?: boolean;
  readonly resumeAt?: string;
  /** Drop the tab's log before starting (a rewind). */
  readonly resetLog?: boolean;
}

/**
 * The nexus commands the agent manager's claude may run without asking,
 * for its session alone (the user's settings are left as they are).
 */
export const MANAGER_ARGS: readonly string[] = ["--allowedTools", "Bash(nexus:*)"];

/**
 * The program's arguments for a tab, going on with a session when asked;
 * the agent manager's (`manager`) with its own on top, and told what it is
 * after what every tab is told, in the one --append-system-prompt claude
 * takes.
 */
export function claudeTabArgs(
  options: ResumeOptions,
  hooksSettings?: string,
  manager = false,
): string[] {
  const prompt = manager ? `${CLAUDE_TAB_PROMPT}\n\n${MANAGER_PROMPT}` : CLAUDE_TAB_PROMPT;
  const args = [
    ...CLAUDE_TAB_ARGS,
    "--append-system-prompt",
    prompt,
    ...(manager ? MANAGER_ARGS : []),
  ];
  if (hooksSettings !== undefined) args.unshift("--settings", hooksSettings);
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
  /** The PATH the agent found the program with. */
  readonly path?: string;
  /** The app's wrapper directory on the workspace's host. */
  readonly wrapperBinDir: string | null;
  readonly agentBin: string | null;
  readonly agentSocket?: string;
  readonly hookToken?: string;
}

export interface ClaudeTabEnvContext extends ChatTabEnvContext {
  /**
   * Set where claude runs without the wrapper (Windows): the marks the
   * wrapper would export.
   */
  readonly withoutWrapper?: boolean;
  /**
   * Where claude's Bash tool runs Git Bash (Windows): the wrappers' copies
   * and the bash shim that puts them first on its PATH.
   */
  readonly gitBash?: { readonly wrapperDir: string; readonly bashEnv: string };
}

/** A Windows path as Git Bash names it: `C:\Users\u` is `/c/Users/u`. */
export function gitBashPath(windowsPath: string): string {
  const slashed = windowsPath.replaceAll("\\", "/");
  return /^[A-Za-z]:/.test(slashed) ? `/${slashed[0]?.toLowerCase()}${slashed.slice(2)}` : slashed;
}

/**
 * The environment a terminal's programs get, which a chat tab's program
 * passes on to the commands it runs: the wrappers first on the PATH (the
 * agent puts them there), and the tab's ids and the agent's hook socket,
 * which they tell the app through.
 */
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
  // Those are for terminal programs.
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  if (context.path !== undefined && context.path !== "") env.PATH = context.path;
  return env;
}

/**
 * The program's environment. With the wrapper on the PATH and the tab's id
 * as both NEXUS_TAB_ID and, once the wrapper runs, NEXUS_CLAUDE_TAB_ID, a
 * `claude -p` the session starts is recorded as one of its agents (#160).
 */
export function claudeTabEnv(context: ClaudeTabEnvContext): Record<string, string> {
  const env = chatTabBaseEnv(context);
  // Lets rewind_files restore the files of a message.
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";
  if (context.withoutWrapper) {
    env.NEXUS_CLAUDE_TAB_ID = context.tabId;
    env.NEXUS_CLAUDE_PRINT = "1";
  }
  if (context.gitBash) {
    // Git Bash runs the wrappers, as in the app's Git Bash terminals, so a
    // `codex exec` or `claude -p` the tab's commands start is one of its
    // agents. They go first on bash's PATH alone: on claude's own, cmd and
    // PowerShell would take a wrapper, a file without an extension, for the
    // program.
    env.BASH_ENV = gitBashPath(context.gitBash.bashEnv);
    env.NEXUS_BASH_WRAPPER_DIR = gitBashPath(context.gitBash.wrapperDir);
  }
  return env;
}

export interface CodexTabEnvContext extends ChatTabEnvContext {
  /** The workspace's shim directory on its host (runtimeDirs' shim files). */
  readonly shimDir: string | null;
}

/**
 * A Codex tab's `codex app-server` environment, which the commands its
 * thread runs inherit: a `claude -p` or `codex exec` one of them starts is
 * recorded as one of the tab's agents, as in a Claude tab. NEXUS_CLAUDE_TAB_ID
 * is the mark of a tab's own session, which the wrappers look for: codex
 * starts without one, so the tab sets it here, and an interactive `claude`
 * a command starts runs without the hooks that would take it for the tab's.
 *
 * codex runs its commands in the user's shell with the environment of a
 * login shell, whose profile may reset the PATH and drop the wrappers from
 * it. The shim files put them back first: a zsh reads them through ZDOTDIR
 * (each passing on to the user's own), a bash through BASH_ENV.
 */
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

/**
 * What a Claude tab may have `claude` do outside its session: the folder's
 * background sessions, the plugins, and /config's list of settings.
 */
export type ClaudeCommand =
  | { kind: "agents" }
  /** Sends a session to the background (or a new one), with a prompt to go on with. */
  | { kind: "background"; sessionId?: string; model?: string; prompt?: string }
  | { kind: "stop"; id: string }
  | { kind: "plugins" }
  /** What a bare /config lists: the settings it takes, for the tab's settings dialog. */
  | { kind: "configUsage" }
  | { kind: "plugin"; action: PluginAction; plugin: string; scope?: "user" | "project" | "local" };

/**
 * `claude`'s arguments for one of those, and nothing else: the ids are
 * checked before they get here, and the prompt comes after `--`, where it
 * can't be taken for an option.
 */
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
      // Run by Claude Code alone, without the model: kept as no session,
      // and starting none of the user's hooks.
      return [
        "-p",
        "--no-session-persistence",
        "--settings",
        '{"disableAllHooks":true}',
        "--output-format",
        "json",
        "/config",
      ];
    case "plugin": {
      const args = ["plugin", command.action, command.plugin, "--json"];
      if (command.scope !== undefined) args.push("--scope", command.scope);
      // A plugin's saved data stays for when it comes back.
      if (command.action === "uninstall") args.push("--keep-data");
      return args;
    }
  }
}

/**
 * The x.y.z of `claude --version`'s output ("2.1.318 (Claude Code)"), or
 * of `codex --version`'s ("codex-cli 0.166.0"); null without one.
 */
export function parseClaudeVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Joins a directory and a file name on the workspace's host. */
export function hostJoin(dir: string, name: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}
