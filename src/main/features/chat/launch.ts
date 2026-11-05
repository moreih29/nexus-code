// How a Claude tab's program is started: `claude -p` in stream-json mode,
// with the tab's marks and the hooks a terminal's claude gets.

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

export interface ResumeOptions {
  readonly resume?: string;
  readonly fork?: boolean;
  readonly resumeAt?: string;
}

/** The program's arguments for a tab, going on with a session when asked. */
export function claudeTabArgs(options: ResumeOptions, hooksSettings?: string): string[] {
  const args = [...CLAUDE_TAB_ARGS];
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

export interface ClaudeTabEnvContext {
  readonly workspaceId: string;
  readonly tabId: string;
  /** The PATH the agent found claude with. */
  readonly path?: string;
  /** The app's wrapper directory on the workspace's host. */
  readonly wrapperBinDir: string | null;
  readonly agentBin: string | null;
  readonly agentSocket?: string;
  readonly hookToken?: string;
  /**
   * Set where claude runs without the wrapper (Windows): the marks the
   * wrapper would export.
   */
  readonly withoutWrapper?: boolean;
}

/**
 * The program's environment. With the wrapper on the PATH and the tab's id
 * as both NEXUS_TAB_ID and, once the wrapper runs, NEXUS_CLAUDE_TAB_ID, a
 * `claude -p` the session starts is recorded as one of its agents (#160).
 */
export function claudeTabEnv(context: ClaudeTabEnvContext): Record<string, string> {
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
  // Lets rewind_files restore the files of a message.
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";
  if (context.withoutWrapper) {
    env.NEXUS_CLAUDE_TAB_ID = context.tabId;
    env.NEXUS_CLAUDE_PRINT = "1";
  }
  return env;
}

/** The x.y.z of `claude --version`'s output ("2.1.318 (Claude Code)"), or null. */
export function parseClaudeVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Joins a directory and a file name on the workspace's host. */
export function hostJoin(dir: string, name: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}
