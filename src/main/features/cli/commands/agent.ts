/**
 * nexus agent ...: the agents of a Claude Code session, as its hooks tell
 * them: its subagents and the `claude -p` runs it starts (hookclient's
 * print-run). A session follows them, waits for one, and stops a run.
 */
import type { AgentRun, ToolRun } from "../../../../shared/claude/activity";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import { type CliContext, CliError, mayChange, pick, resolveWorkspace, shortId } from "../context";
import { ago, oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, WAIT_POLL_MS } from "../wait";
import { WORKSPACE_FLAG } from "./flags";
import { resolveTerminal } from "./terminal";

const SESSION_FLAGS = {
  tab: {
    type: "string",
    value: "TAB",
    description: "The terminal whose session it is (id, id prefix or title); this one by default",
  },
  workspace: WORKSPACE_FLAG,
} as const;

const SESSION_DETAILS =
  "The agents are those of the Claude Code session in this terminal, or in --tab: its\n" +
  'subagents, and the "claude -p" and "codex exec" runs it starts. A run is named by its\n' +
  'session id; claude -p --resume <id> "..." (codex exec resume <id> "...") goes on with it,\n' +
  "and is listed as the same run going on.";

const AGENT_DETAILS =
  "<agent> is an id from nexus agent list, or a unique prefix of one (4 characters or more).";

interface Session {
  workspaceId: string;
  tabId: string;
  /** How messages name the terminal when it is not the caller's. */
  title?: string;
}

/** The terminal whose session a command looks at: the caller's, or --tab's. */
async function sessionOf(ctx: CliContext, flags: ParsedArgs["flags"]): Promise<Session> {
  const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
  if (flags.tab === undefined) {
    if (workspace.id !== ctx.caller.workspaceId) throw new CliUsageError("--workspace needs --tab");
    return ctx.caller;
  }
  const tab = await resolveTerminal(ctx, workspace, flags.tab as string);
  return { workspaceId: workspace.id, tabId: tab.id, title: tab.title };
}

function agentsOf(ctx: CliContext, session: Session): readonly AgentRun[] {
  return ctx.services.claudeAgents.list(session.workspaceId, session.tabId);
}

/** The id an agent is shown by: a run's Claude session id once known. */
export function agentId(agent: AgentRun): string {
  if (agent.kind === "subagent") return agent.id;
  return agent.sessionId ?? agent.id.replace(/^print-/, "");
}

function agentKind(agent: AgentRun): string {
  if (agent.kind === "subagent") return agent.type ?? "subagent";
  return agent.program === "codex" ? "codex exec" : "claude -p";
}

/** The agent `selector` names among the session's: an id, or a unique prefix. */
function findAgent(agents: readonly AgentRun[], selector: string, session: Session): AgentRun {
  const exact = agents.find((a) => a.id === selector || a.sessionId === selector);
  if (exact) return exact;
  if (agents.length === 0) {
    throw new CliError(
      session.title === undefined
        ? "this terminal's session has no agents"
        : `the session in ${session.title} has no agents`,
    );
  }
  return pick(agents, selector, agentId, agentKind, "agent");
}

function isRunning(agent: AgentRun): boolean {
  return agent.end === undefined;
}

/** The tool it runs now, the latest one started. */
function runningTool(agent: AgentRun): ToolRun | undefined {
  return [...agent.tools].reverse().find((t) => t.end === undefined && t.background !== true);
}

function toolLine(tool: ToolRun): string {
  return tool.target === undefined ? tool.name : `${tool.name} ${tool.target}`;
}

function stateText(agent: AgentRun): string {
  const exit = agent.exitCode === undefined ? "" : ` (exit ${agent.exitCode})`;
  const state = agent.state === "permissionPending" ? "waiting to be allowed a tool" : agent.state;
  return `${state}${exit}`;
}

/** Its tools in a few words: how many ran and failed; "?" when a run does not tell them. */
function toolCount(agent: AgentRun): string {
  if (agent.kind === "print" && agent.toolsTold !== true) return "?";
  return agent.failedCount > 0
    ? `${agent.toolCount} (${agent.failedCount} failed)`
    : `${agent.toolCount}`;
}

function task(agent: AgentRun): string {
  return agent.description ?? agent.prompt ?? "";
}

function agentJson(agent: AgentRun): Record<string, unknown> {
  return { ...agent, id: agentId(agent), agentId: agent.id };
}

const agentList: CliCommand = {
  path: ["agent", "list"],
  summary: "List the subagents, claude -p and codex exec runs of this terminal's Claude session",
  details: SESSION_DETAILS,
  flags: SESSION_FLAGS,
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const session = await sessionOf(ctx, flags);
    const agents = agentsOf(ctx, session);
    const now = ctx.services.clock.now();
    const text = table(
      ["ID", "AGENT", "STATE", "SINCE", "TOOLS", "NOW", "TASK"],
      agents.map((a) => {
        const tool = isRunning(a) ? runningTool(a) : undefined;
        return [
          shortId(agentId(a)),
          agentKind(a),
          stateText(a),
          ago(a.end ?? a.start, now),
          toolCount(a),
          tool ? oneLine(toolLine(tool), 40) : "",
          oneLine(task(a), 50),
        ];
      }),
    );
    return output(text || "No agents.", agents.map(agentJson));
  },
};

/** What `nexus agent show` and `wait` print of an agent. */
function describeAgent(agent: AgentRun, now: number): string {
  const lines = [`${agentKind(agent)} ${agentId(agent)}`];
  const field = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") lines.push(`${`${name}:`.padEnd(9)}${value}`);
  };
  const ran = (agent.end ?? now) - agent.start;
  field(
    "State",
    `${stateText(agent)}${agent.background ? ", in the background" : ""}, ${
      isRunning(agent) ? `started ${ago(agent.start, now)}` : `ended ${ago(agent.end ?? now, now)}`
    }, ran ${Math.round(ran / 1000)}s`,
  );
  field("Model", agent.model);
  field("Via", agent.endpoint);
  if (agent.kind === "print" && agent.sessionId !== undefined) {
    const resume =
      agent.program === "codex"
        ? `codex exec resume ${agent.sessionId}`
        : `claude -p --resume ${agent.sessionId}`;
    field("Session", `${agent.sessionId} (${resume} goes on)`);
  }
  field("Task", agent.description);
  field("Prompt", agent.prompt === undefined ? undefined : oneLine(agent.prompt, 300));
  if (agent.kind === "print" && agent.toolsTold !== true) {
    lines.push("Tools:   not told by this run");
  } else if (agent.toolCount > 0) {
    const kept = agent.tools.length < agent.toolCount ? `, the last ${agent.tools.length}` : "";
    const failed = agent.failedCount > 0 ? `, ${agent.failedCount} failed` : "";
    lines.push(`Tools (${agent.toolCount}${failed}${kept}):`);
    for (const tool of agent.tools) {
      const how =
        tool.end === undefined
          ? tool.background
            ? "background"
            : "running"
          : tool.denied
            ? "denied"
            : tool.failed
              ? "failed"
              : "ok";
      const error = tool.error === undefined ? "" : `: ${oneLine(tool.error, 100)}`;
      lines.push(`  ${how.padEnd(10)} ${oneLine(toolLine(tool), 100)}${error}`);
    }
  }
  if (agent.answer !== undefined) lines.push("Answer:", agent.answer);
  return lines.join("\n");
}

const agentShow: CliCommand = {
  path: ["agent", "show"],
  summary: "Show an agent of this terminal's Claude session: its state, tools and answer",
  args: "<agent>",
  details: `${AGENT_DETAILS}\n${SESSION_DETAILS}`,
  flags: SESSION_FLAGS,
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "agent") as [string];
    const session = await sessionOf(ctx, flags);
    const agent = findAgent(agentsOf(ctx, session), selector, session);
    return output(describeAgent(agent, ctx.services.clock.now()), agentJson(agent));
  },
};

const agentWait: CliCommand = {
  path: ["agent", "wait"],
  summary: "Wait until an agent of this terminal's Claude session ends, then show it",
  args: "<agent>",
  details:
    `${AGENT_DETAILS}\n` +
    "It prints what nexus agent show does, the answer last. A run that goes on with --resume\n" +
    "while it is waited on is waited on again. When the wait runs out, nexus exits with 124.",
  flags: {
    timeout: {
      type: "string",
      value: "DURATION",
      description: "Stop waiting after DURATION, such as 90s or 5m (default 10m, at most 30m)",
    },
    ...SESSION_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "agent") as [string];
    const timeoutMs =
      flags.timeout === undefined
        ? DEFAULT_WAIT_MS
        : parseDuration(flags.timeout as string, "timeout");
    if (timeoutMs > MAX_WAIT_MS) throw new CliUsageError("--timeout is at most 30m");
    const session = await sessionOf(ctx, flags);
    const { id } = findAgent(agentsOf(ctx, session), selector, session);
    const { clock } = ctx.services;
    const deadline = clock.now() + timeoutMs;
    for (;;) {
      const now = clock.now();
      const agent = agentsOf(ctx, session).find((a) => a.id === id);
      if (agent === undefined) {
        throw new CliError(`${selector} is gone; its session has ended or was cleared`);
      }
      if (!isRunning(agent)) return output(describeAgent(agent, now), agentJson(agent));
      if (now >= deadline || ctx.signal?.aborted) {
        return output(
          `${agentKind(agent)} ${shortId(agentId(agent))} was still ${stateText(agent)} when the wait ran out.`,
          { ...agentJson(agent), timedOut: true },
          { exitCode: 124 },
        );
      }
      await clock.sleep(WAIT_POLL_MS);
    }
  },
};

const agentStop: CliCommand = {
  path: ["agent", "stop"],
  summary: "Stop a claude -p or codex exec run of this terminal's Claude session",
  args: "<agent>",
  details:
    `${AGENT_DETAILS}\n` +
    "Its program gets an interrupt, then is ended if it has not stopped after 5 seconds. A\n" +
    "subagent cannot be stopped this way: it stops with its session's turn.",
  flags: SESSION_FLAGS,
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "agent") as [string];
    const session = await sessionOf(ctx, flags);
    const agent = findAgent(agentsOf(ctx, session), selector, session);
    const name = `${agentKind(agent)} ${shortId(agentId(agent))}`;
    if (agent.kind !== "print") {
      throw new CliError(`${name} is a subagent; it stops with its session's turn`);
    }
    if (!isRunning(agent)) throw new CliError(`${name} has already ended (${stateText(agent)})`);
    const workspace = resolveWorkspace(ctx, session.workspaceId);
    await mayChange(ctx, workspace, { kind: "terminalInput", detail: session.title });
    const stopped = await ctx.services.claudeAgents.stop(
      session.workspaceId,
      session.tabId,
      agent.id,
    );
    if (!stopped) throw new CliError(`${name} cannot be stopped from the app; it holds no watch`);
    return output(`Stopping ${name}.`, agentJson(agent));
  },
};

export const agentCommands: CliCommand[] = [agentList, agentShow, agentWait, agentStop];
