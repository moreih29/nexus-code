/**
 * What the app tells the agent manager of the sessions: which of their
 * changes it hears of, as its settings say, and the message a batch of them
 * makes. Pure; ./feed sends it.
 */

import type { CliSessionEvent } from "../../../shared/cli/ui";
import type { ManagerNotify } from "../../../shared/manager/manager";
import { MANAGER_EVENTS_PREFIX } from "../../../shared/manager/prompt";
import { phaseOf } from "../sessions/model";

/** How much of a session's last answer or question a report quotes. */
const MESSAGE_CHARS = 600;

/**
 * Whether the manager hears of a change: a session of its tasks that
 * finished, waits on someone, failed or closed; with "attention" also any
 * other that waits on the user or failed; with "all" any of those. Going to
 * work, or a finished session being looked at, tells nothing.
 */
export function reportable(event: CliSessionEvent, notify: ManagerNotify, task: boolean): boolean {
  const ended =
    event.phase === "attention" ||
    event.phase === "done" ||
    event.phase === "closed" ||
    (event.phase === "idle" && event.from !== null && phaseOf(event.from) === "running");
  if (!ended) return false;
  if (task || notify === "all") return true;
  return notify === "attention" && event.phase === "attention";
}

/** The states a report tells, by what it says of them; a finished session's is "completed". */
export type ReportState = "permissionPending" | "needsInput" | "error" | "completed" | "closed";

const STATE_LINES: Readonly<Record<ReportState, string>> = {
  permissionPending: "waits for a permission",
  needsInput: "waits for an answer",
  error: "stopped on an error",
  completed: "finished",
  closed: "closed (its tab is gone)",
};

/** A state as the report tells it. */
function stateLine(to: string): string {
  if (to === "idle") return STATE_LINES.completed;
  return STATE_LINES[to as ReportState] ?? to;
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** What a session is: an agent and where it runs. */
function whatOf(event: CliSessionEvent): string {
  if (event.kind === "terminal") return `${event.agent ?? "agent"} in a terminal`;
  return `${event.kind === "codex" ? "Codex" : "Claude"} tab`;
}

export interface ReportInput {
  /** The changes to tell, oldest first; one a session, its latest. */
  readonly events: readonly CliSessionEvent[];
  /** Session keys of the manager's tasks. */
  readonly tasks: ReadonlySet<string>;
  readonly workspaceName: (workspaceId: string) => string | undefined;
}

/**
 * The message telling the manager of `events`: a line each, with the ids
 * nexus takes, and what the session last said.
 */
export function reportOf({ events, tasks, workspaceName }: ReportInput): string {
  const last = events.at(-1)?.seq ?? 0;
  const head =
    events.length === 1
      ? `${MANAGER_EVENTS_PREFIX} A session changed (event #${last}):`
      : `${MANAGER_EVENTS_PREFIX} ${events.length} sessions changed (events up to #${last}):`;
  const lines = [head];
  for (const event of events) {
    const ws = workspaceName(event.workspaceId) ?? "a workspace";
    const ids = `--workspace ${event.workspaceId.slice(0, 8)}, tab ${event.tabId.slice(0, 8)}`;
    const mine = tasks.has(`${event.workspaceId}:${event.tabId}`) ? " — your task" : "";
    lines.push(
      `- "${clip(event.title, 80)}" ${stateLine(event.to)}: ${whatOf(event)} in ${ws} (${ids})${mine}`,
    );
    if (event.message) lines.push(`  Last said: ${clip(event.message, MESSAGE_CHARS)}`);
  }
  lines.push(`Every change since: nexus events --since ${Math.max(0, (events[0]?.seq ?? 1) - 1)}`);
  return lines.join("\n");
}

/** Whether a message of the manager's conversation is one of the app's reports. */
export function isReport(text: string): boolean {
  return text.startsWith(MANAGER_EVENTS_PREFIX);
}

/** A session a report tells of: its title and state, read back from the report's text. */
export interface ReportedSession {
  readonly title: string;
  readonly state: ReportState | undefined;
}

/** The sessions a report tells of, in its order. */
export function reportedSessions(text: string): ReportedSession[] {
  const sessions: ReportedSession[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith('- "')) continue;
    const entry = Object.entries(STATE_LINES).find(([, said]) => line.includes(`" ${said}: `));
    const end = entry ? line.indexOf(`" ${entry[1]}: `) : line.lastIndexOf('"');
    sessions.push({
      title: line.slice(3, end > 3 ? end : undefined),
      state: entry?.[0] as ReportState | undefined,
    });
  }
  return sessions;
}

/**
 * Batches the reportable changes, a session's latest in place of its
 * earlier ones, until they are taken.
 */
export class ReportQueue {
  private readonly pending = new Map<string, CliSessionEvent>();

  add(event: CliSessionEvent): void {
    const key = `${event.workspaceId}:${event.tabId}`;
    // Its latest goes last.
    this.pending.delete(key);
    this.pending.set(key, event);
  }

  get size(): number {
    return this.pending.size;
  }

  /** The changes batched, oldest first, and the queue emptied. */
  take(): CliSessionEvent[] {
    const events = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
    this.pending.clear();
    return events;
  }
}
