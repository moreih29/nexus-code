/**
 * Waiting on a terminal, for nexus terminal wait and terminal send --wait:
 * until it is idle, has exited, or shows a pattern.
 *
 * Idle is told the best way each terminal allows. Claude Code reports its
 * turns through the app's hooks. Codex and other agents are idle once they
 * raise a notification or stop printing; their spinners print while they
 * work. A plain shell is idle once it holds the foreground again.
 */
import type { CliTabInfo } from "../../../shared/cli/ui";
import { isLoginShell } from "../../../shared/pty/login-shell";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { terminalState } from "./agent-state";
import type { CliContext } from "./context";
import { oneLine } from "./format";
import { FIRST_TURN_GRACE_MS } from "./started-agents";

export const WAIT_POLL_MS = 500;
export const DEFAULT_WAIT_MS = 10 * 60_000;
export const MAX_WAIT_MS = 30 * 60_000;
/** How long an agent's output must stay still for it to count as idle. */
export const DEFAULT_QUIET_MS = 5_000;
/**
 * After typing into a terminal, how long a turn or command has to start
 * before the terminal counts as idle anyway (the text started nothing).
 */
const AGENT_START_GRACE_MS = 10_000;
const COMMAND_START_GRACE_MS = 2_000;
/** How much of the screen a --match pattern is looked for in. */
const MATCH_LINES = 200;

/** Programs that are agents, when the title does not say so. */
const AGENT_PROGRAMS = /^(claude|codex|gemini|aider|opencode|amp|cursor-agent|goose)$/i;

export type WaitTarget = { kind: "idle" } | { kind: "exit" } | { kind: "match"; pattern: RegExp };

export interface WaitOptions {
  readonly target: WaitTarget;
  readonly timeoutMs: number;
  readonly quietMs: number;
  /** When the wait began; for --wait, just before the input was typed. */
  readonly startedAt: number;
  /** Whether input was just typed, so a turn or command is expected to start. */
  readonly afterInput: boolean;
}

export interface WaitResult {
  /** False when the wait timed out. */
  readonly done: boolean;
  /**
   * What ended it: idle, completed, needsInput, permissionPending, error, notStarted,
   * notified, exited, matched, timeout.
   */
  readonly state: string;
  readonly text: string;
  readonly message?: string;
}

const settled = (state: string, text: string, message?: string): WaitResult => ({
  done: true,
  state,
  text,
  ...(message ? { message } : {}),
});

function claudeResult(status: string, message: string | undefined): WaitResult {
  switch (status) {
    case "completed":
      return settled(
        status,
        message ? `Claude Code finished:\n${message}` : "Claude Code finished.",
        message,
      );
    case "needsInput":
      return settled(
        status,
        `Claude Code is waiting for the user${message ? `: ${message}` : "."}`,
        message,
      );
    case "error":
      return settled(
        status,
        `Claude Code stopped on an error${message ? `: ${message}` : "."}`,
        message,
      );
    case "permissionPending":
      return settled(
        status,
        `Claude Code is waiting for the user to allow a tool${message ? `: ${message}` : "."}`,
        message,
      );
    default:
      return settled(status, "Claude Code is idle.", message);
  }
}

class Waiter {
  private sawBusy = false;
  /** Whether the agent worktree new started has begun its first turn. */
  private sawTurn = false;
  /** When worktree new started the terminal's agent with a prompt, if lately. */
  private readonly agentStartedAt: number | undefined;

  constructor(
    private readonly ctx: CliContext,
    private readonly workspace: WorkspaceMeta,
    private readonly tab: CliTabInfo,
    private readonly options: WaitOptions,
  ) {
    this.agentStartedAt = ctx.services.startedAgents.since(
      { workspaceId: workspace.id, tabId: tab.id },
      options.startedAt,
    );
  }

  /**
   * Whether the agent worktree new started is yet to begin its first turn:
   * its command not typed or not running yet, or Claude Code idle at its
   * start. Not past FIRST_TURN_GRACE_MS, for a command that started nothing.
   */
  private beforeFirstTurn(now: number): boolean {
    const startedAt = this.agentStartedAt;
    return startedAt !== undefined && !this.sawTurn && now - startedAt < FIRST_TURN_GRACE_MS;
  }

  private get services() {
    return this.ctx.services;
  }

  private elapsed(now: number): number {
    return now - this.options.startedAt;
  }

  /** The result if the wait is over, else null. */
  async check(now: number): Promise<WaitResult | null> {
    const tabs = (await this.services.ui("tabs.list", { workspaceId: this.workspace.id })).tabs;
    const current = tabs.find((t) => t.id === this.tab.id);
    if (!current) return settled("exited", `${this.tab.title} was closed.`);
    if (current.dead) return settled("exited", `${this.tab.title} has exited.`);
    const { target } = this.options;
    if (target.kind === "exit") return null;
    if (target.kind === "match") return this.checkMatch(target.pattern);
    return this.checkIdle(current, now);
  }

  private async checkMatch(pattern: RegExp): Promise<WaitResult | null> {
    const { text } = await this.services.ui("terminal.read", {
      workspaceId: this.workspace.id,
      tabId: this.tab.id,
      lines: MATCH_LINES,
    });
    const line = text.split("\n").find((l) => pattern.test(l));
    return line === undefined ? null : settled("matched", line);
  }

  private async checkIdle(tab: CliTabInfo, now: number): Promise<WaitResult | null> {
    const { afterInput, startedAt } = this.options;
    const claude = this.services.claudeStatus(this.workspace.id, tab.id);
    if (claude) {
      if (claude.status === "running") {
        this.sawBusy = true;
        this.sawTurn = true;
        return null;
      }
      // A turn that ended between two looks.
      const { turnStartedAt } = claude;
      const { agentStartedAt } = this;
      if (
        agentStartedAt !== undefined &&
        turnStartedAt !== undefined &&
        turnStartedAt >= agentStartedAt
      ) {
        this.sawTurn = true;
      }
      if (this.beforeFirstTurn(now)) return null;
      const started =
        !afterInput || this.sawBusy || (turnStartedAt !== undefined && turnStartedAt >= startedAt);
      if (started) return claudeResult(claude.status, claude.message);
      // The text started no turn, as a slash command may not: what Claude
      // Code last said is from an earlier turn.
      return this.elapsed(now) >= AGENT_START_GRACE_MS
        ? settled("notStarted", "Claude Code started no turn from the input.")
        : null;
    }

    const state = terminalState(this.services, this.workspace.id, tab.id, tab.title, now);
    const program = await this.services.foregroundProcess(this.workspace.id, tab.id);
    const isAgent =
      state.agent !== undefined ||
      state.message !== undefined ||
      (program !== null && AGENT_PROGRAMS.test(program));
    if (!isAgent && program !== null && program !== "") {
      if (!isLoginShell(program)) {
        this.sawBusy = true;
        return null;
      }
      if (this.beforeFirstTurn(now)) return null;
      const started = !afterInput || this.sawBusy || this.elapsed(now) >= COMMAND_START_GRACE_MS;
      return started ? settled("idle", `${tab.title} is back at its prompt.`) : null;
    }

    const activity = this.services.activity(this.workspace.id, tab.id);
    const notice = activity?.lastNotice;
    if (notice && notice.at >= startedAt) {
      const message = notice.title ? `${notice.title}: ${notice.body}` : notice.body;
      return settled("notified", `${tab.title} says: ${oneLine(message, 500)}`, message);
    }
    const lastOutput = activity?.lastOutputAt ?? 0;
    // Output from a started agent is its turn; not Claude Code's, which
    // prints as it starts and tells its turns through the hooks.
    const claudeStarting = state.agent === "claude" || program === "claude";
    const { agentStartedAt } = this;
    if (agentStartedAt !== undefined && !claudeStarting && lastOutput >= agentStartedAt) {
      this.sawTurn = true;
    }
    if (this.beforeFirstTurn(now)) return null;
    if (now - lastOutput < this.options.quietMs) return null;
    const started =
      !afterInput || lastOutput >= startedAt || this.elapsed(now) >= AGENT_START_GRACE_MS;
    return started ? settled("idle", `${tab.title} has been quiet for a while.`) : null;
  }
}

/** Waits on a terminal as `options` say; never throws for a timeout. */
export async function waitOnTerminal(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  tab: CliTabInfo,
  options: WaitOptions,
): Promise<WaitResult> {
  const { clock } = ctx.services;
  const waiter = new Waiter(ctx, workspace, tab, options);
  const deadline = options.startedAt + options.timeoutMs;
  const end = ctx.services.waits.begin(
    ctx.caller,
    { workspaceId: workspace.id, tabId: tab.id },
    options.startedAt,
  );
  try {
    for (;;) {
      const now = clock.now();
      const result = await waiter.check(now);
      if (result) return result;
      if (now >= deadline) {
        return {
          done: false,
          state: "timeout",
          text: `${tab.title} was still busy when the wait ran out; see it with "nexus terminal read".`,
        };
      }
      await clock.sleep(WAIT_POLL_MS);
    }
  } finally {
    end();
  }
}
