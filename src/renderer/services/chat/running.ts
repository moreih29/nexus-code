import type { ChatItem, ChatModel, ToolCall } from "./model";
import { AGENT_TOOLS, type AgentRow, type AgentStatus, jobsOf } from "./panel";

export interface JobLike {
  taskId: string;
  type: string;
  description: string;
  status: string;
  toolUseId?: string;
  backgrounded?: boolean;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
}

export type ActivityKind = "agent" | "command" | "run";

export interface ActivityRow<J extends JobLike = JobLike> {
  key: string;
  kind: ActivityKind;
  status: AgentStatus;
  description: string;
  startedAt?: number;
  endedAt?: number;
  waited: boolean;
  foreground?: string;
  background: boolean;
  agent?: AgentRow;
  job?: J;
  call?: ToolCall;
}

export interface Activity<J extends JobLike = JobLike> {
  running: ActivityRow<J>[];
  ended: ActivityRow<J>[];
}

export function canBackground(tool: ToolCall): boolean {
  if (tool.status !== "running" || tool.parentToolUseId) return false;
  if (tool.name !== "Bash" && !AGENT_TOOLS.has(tool.name)) return false;
  return (tool.input as { run_in_background?: unknown } | null)?.run_in_background !== true;
}

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

export function commandLabel(tool: ToolCall): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const said = str(input.description)?.trim();
  if (said) return said;
  return str(input.command)?.split("\n")[0]?.trim() || tool.name;
}

function startsOf(items: readonly ChatItem[], ids: ReadonlySet<string>): Map<string, number> {
  const starts = new Map<string, number>();
  if (ids.size === 0) return starts;
  for (let i = items.length - 1; i >= 0 && starts.size < ids.size; i--) {
    const item = items[i];
    if (item.kind !== "assistant" || item.at === undefined) continue;
    for (const block of item.blocks) {
      if (block.type === "tool" && ids.has(block.toolUseId)) starts.set(block.toolUseId, item.at);
    }
  }
  return starts;
}

export function activityOf<J extends JobLike>({
  agents,
  jobs,
  tools,
  items,
  waiting,
  turnRunning = true,
}: {
  agents: readonly AgentRow[];
  jobs: readonly J[];
  tools: Record<string, ToolCall>;
  items: readonly ChatItem[];
  waiting?: ReadonlySet<string>;
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

export const WAITED_CALL_DELAY_MS = 3_000;

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

export function endedAtOf(row: Pick<ActivityRow, "startedAt" | "endedAt">): number | undefined {
  return row.endedAt ?? row.startedAt;
}

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

export function searchActivity<R extends ActivityRow>(rows: readonly R[], query: string): R[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows as R[];
  return rows.filter((row) => {
    const text = activityText(row);
    return words.every((word) => text.includes(word));
  });
}

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
