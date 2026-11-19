// What the side panel's Tasks and Agents sections list: what the session
// runs now (its background jobs and the commands its turn waits on; its
// subagents and the `claude -p` runs it started), and below, folded, what
// ended, newest first.

import type { ChatItem, ChatModel, ToolCall } from "./model";
import { AGENT_TOOLS, type AgentRow, type AgentStatus, jobsOf } from "./panel";

/** A background job as the panel takes it: a task of the tab's, or as another computer tells one. */
export interface JobLike {
  taskId: string;
  /** local_bash, a workflow's, as the CLI names it. */
  type: string;
  description: string;
  /** running, then completed, failed, killed or stopped. */
  status: string;
  toolUseId?: string;
  backgrounded?: boolean;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
}

/** What a row is: a subagent, a command (a background job), or a `claude -p` run. */
export type ActivityKind = "agent" | "command" | "run";

export interface ActivityRow<J extends JobLike = JobLike> {
  /** Unique among the rows: the Agent call's id, a job's task, a run's key, a call's. */
  key: string;
  kind: ActivityKind;
  status: AgentStatus;
  description: string;
  startedAt?: number;
  endedAt?: number;
  /** The turn waits on it: a command or a subagent it did not start in the background. */
  waited: boolean;
  /** The call that can go to the background now, by its id: one waited on that asks nothing. */
  foreground?: string;
  /** It runs beside the turn, which goes on without it. */
  background: boolean;
  agent?: AgentRow;
  job?: J;
  /** A command the turn waits on that no task tells yet: its call. */
  call?: ToolCall;
}

export interface Activity<J extends JobLike = JobLike> {
  /** What runs now: what the turn waits on first, then the rest, each in the order it started. */
  running: ActivityRow<J>[];
  /** What ended, the newest first. */
  ended: ActivityRow<J>[];
}

/**
 * Whether a running call can go to the background: a command or a
 * subagent on the main thread that was not started there already.
 */
export function canBackground(tool: ToolCall): boolean {
  if (tool.status !== "running" || tool.parentToolUseId) return false;
  if (tool.name !== "Bash" && !AGENT_TOOLS.has(tool.name)) return false;
  return (tool.input as { run_in_background?: unknown } | null)?.run_in_background !== true;
}

/** A job's state as a row's: killed is stopped. */
export function jobStatus(status: string): AgentStatus {
  switch (status) {
    case "running":
    case "completed":
    case "failed":
      return status;
    default:
      return "stopped";
  }
}

/** The CLI can confirm the handoff before the foreground call returns. */
function waitsForJob(job: JobLike, waitsForCall: boolean): boolean {
  return waitsForCall && job.backgrounded !== true;
}

export type ToolRowStatus = ToolCall["status"] | "background";
export type ToolRowStatuses = Readonly<Partial<Record<string, ToolRowStatus>>>;

const JOB_TOOL_STATUS = {
  running: "background",
  completed: "done",
  failed: "error",
  stopped: "stopped",
} as const;

/** A handed-off call's row follows the job once the CLI starts tracking it. */
export function jobToolStatuses({
  tasks,
  tools,
  running,
}: Pick<ChatModel, "tasks" | "tools" | "running">): ToolRowStatuses {
  const statuses: Partial<Record<string, ToolRowStatus>> = {};
  for (const job of jobsOf({ tasks })) {
    const id = job.toolUseId;
    const tool = id ? tools[id] : undefined;
    if (!id || !tool || tool.status === "denied") continue;
    if (waitsForJob(job, running && canBackground(tool))) continue;
    statuses[id] = JOB_TOOL_STATUS[jobStatus(job.status)];
  }
  return statuses;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A command's line as a row says it: what the model said it does, else its first line. */
export function commandLabel(tool: ToolCall): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const said = str(input.description)?.trim();
  if (said) return said;
  return str(input.command)?.split("\n")[0]?.trim() || tool.name;
}

/** When each call began, by the message that made it; only the calls asked for. */
function startsOf(items: readonly ChatItem[], ids: ReadonlySet<string>): Map<string, number> {
  const starts = new Map<string, number>();
  if (ids.size === 0) return starts;
  // The calls a turn waits on are in its last messages.
  for (let i = items.length - 1; i >= 0 && starts.size < ids.size; i--) {
    const item = items[i];
    if (item.kind !== "assistant" || item.at === undefined) continue;
    for (const block of item.blocks) {
      if (block.type === "tool" && ids.has(block.toolUseId)) starts.set(block.toolUseId, item.at);
    }
  }
  return starts;
}

/**
 * The session's activity as the panel lists it. A call the turn
 * waits on is one row with what it runs: a subagent's, or a command's job
 * once it has one.
 */
export function activityOf<J extends JobLike>({
  agents,
  jobs,
  tools,
  items,
  waiting,
  turnRunning = true,
}: {
  /** The subagents and runs, in the order they started. */
  agents: readonly AgentRow[];
  /** The background jobs, in the order they started. */
  jobs: readonly J[];
  /** The calls of the conversation, for those its turn waits on. */
  tools: Record<string, ToolCall>;
  /** The conversation, for when a waited-on call began. */
  items: readonly ChatItem[];
  /** Calls that wait on the user's answer: they cannot go to the background yet. */
  waiting?: ReadonlySet<string>;
  /** A turn runs: only then does one wait on a call. */
  turnRunning?: boolean;
}): Activity<J> {
  const waited = new Map<string, ToolCall>();
  if (turnRunning) {
    for (const tool of Object.values(tools)) {
      if (canBackground(tool)) waited.set(tool.id, tool);
    }
  }
  const foregroundOf = (id: string | undefined) =>
    id !== undefined && waited.has(id) && !waiting?.has(id) ? id : undefined;
  const rows: ActivityRow<J>[] = [];
  const told = new Set<string>();
  for (const agent of agents) {
    told.add(agent.toolUseId);
    const kind: ActivityKind = agent.run ? "run" : "agent";
    const running = agent.status === "running";
    const isWaited = running && !agent.run && waited.has(agent.toolUseId);
    rows.push({
      key: agent.toolUseId,
      kind,
      status: agent.status,
      description: agent.description,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      waited: isWaited,
      ...(isWaited && foregroundOf(agent.toolUseId) ? { foreground: agent.toolUseId } : {}),
      background: running && kind === "agent" && !isWaited,
      agent,
    });
  }
  for (const job of jobs) {
    if (job.toolUseId) told.add(job.toolUseId);
    const status = jobStatus(job.status);
    const running = status === "running";
    // A command just sent to the background is the job its call started.
    const isWaited =
      running && waitsForJob(job, job.toolUseId !== undefined && waited.has(job.toolUseId));
    rows.push({
      key: `job:${job.taskId}`,
      kind: "command",
      status,
      description: job.description || job.taskId,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      waited: isWaited,
      ...(isWaited && foregroundOf(job.toolUseId) ? { foreground: job.toolUseId } : {}),
      background: running && !isWaited,
      job,
    });
  }
  // The commands the turn waits on that no job tells yet.
  const calls = [...waited.values()].filter((tool) => tool.name === "Bash" && !told.has(tool.id));
  const starts = startsOf(items, new Set(calls.map((tool) => tool.id)));
  for (const call of calls) {
    rows.push({
      key: `call:${call.id}`,
      kind: "command",
      status: "running",
      description: commandLabel(call),
      startedAt: starts.get(call.id),
      waited: true,
      ...(foregroundOf(call.id) ? { foreground: call.id } : {}),
      background: false,
      call,
    });
  }
  const order = new Map(rows.map((row, i) => [row, i] as const));
  const running = rows
    .filter((row) => row.status === "running")
    .sort(
      (a, b) =>
        Number(b.waited) - Number(a.waited) ||
        (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY) ||
        (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
  return { running, ended: newestEndedFirst(rows.filter((row) => row.status !== "running")) };
}

/**
 * The session's activity as the panel's two sections list it: its commands
 * (the Tasks section), and its subagents and `claude -p` runs (the Agents
 * section), each with what runs and what ended in the same order.
 */
export function activityParts<J extends JobLike>(
  activity: Activity<J>,
): { commands: Activity<J>; agents: Activity<J> } {
  const commands: Activity<J> = { running: [], ended: [] };
  const agents: Activity<J> = { running: [], ended: [] };
  for (const row of activity.running)
    (row.kind === "command" ? commands : agents).running.push(row);
  for (const row of activity.ended) (row.kind === "command" ? commands : agents).ended.push(row);
  return { commands, agents };
}

/**
 * How long a command the turn waits on runs before it is listed: most end
 * sooner, and a row for each would come and go as the turn calls them.
 */
export const WAITED_CALL_DELAY_MS = 3_000;

/**
 * The running rows to list at `now`: all but the commands the turn waits on
 * (with no job yet) that began less than WAITED_CALL_DELAY_MS ago, by their
 * start, else by when they were first `seen`. `nextAt`: when the first of
 * those held back is due.
 */
export function heldBack<R extends ActivityRow>(
  rows: readonly R[],
  now: number,
  seen: ReadonlyMap<string, number> = new Map(),
): { shown: R[]; nextAt?: number } {
  let nextAt: number | undefined;
  const shown = rows.filter((row) => {
    if (!row.call) return true;
    const from = row.startedAt ?? seen.get(row.key) ?? now;
    const due = from + WAITED_CALL_DELAY_MS;
    if (due <= now) return true;
    nextAt = nextAt === undefined ? due : Math.min(nextAt, due);
    return false;
  });
  return shown.length === rows.length ? { shown: rows as R[] } : { shown, nextAt };
}

/** When a row ended, as far as it is known: its end, else its start. */
export function endedAtOf(row: Pick<ActivityRow, "startedAt" | "endedAt">): number | undefined {
  return row.endedAt ?? row.startedAt;
}

/** Ended rows, the newest first: those with no time after, the later listed first. */
export function newestEndedFirst<R extends Pick<ActivityRow, "startedAt" | "endedAt">>(
  rows: readonly R[],
): R[] {
  return rows
    .map((row, i) => ({ row, i, at: endedAtOf(row) }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return b.at - a.at;
      if (a.at === undefined && b.at !== undefined) return 1;
      if (b.at === undefined && a.at !== undefined) return -1;
      return b.i - a.i;
    })
    .map(({ row }) => row);
}

/** What a row is found by: its words, its subagent's kind and model, its job's. */
export function activityText(row: ActivityRow): string {
  return [
    row.description,
    row.agent?.subagentType,
    row.agent?.model,
    row.job?.type,
    row.job?.summary,
    row.call ? str((row.call.input as Record<string, unknown> | null)?.command) : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/** The rows a search keeps, in their order: each word of it found in the row. */
export function searchActivity<R extends ActivityRow>(rows: readonly R[], query: string): R[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows as R[];
  return rows.filter((row) => {
    const text = activityText(row);
    return words.every((word) => text.includes(word));
  });
}

/**
 * Whether two lists of ended rows show the same: each row's words, state,
 * times and job. A list made again from a chat that changed elsewhere (a
 * call streaming in) is kept, so what draws it need not draw again.
 */
export function sameEndedRows(a: readonly ActivityRow[], b: readonly ActivityRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.key === other.key &&
      row.kind === other.kind &&
      row.status === other.status &&
      row.description === other.description &&
      row.startedAt === other.startedAt &&
      row.endedAt === other.endedAt &&
      row.job === other.job
    );
  });
}
