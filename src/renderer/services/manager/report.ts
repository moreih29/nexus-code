/**
 * What the app tells the agent manager of the sessions: which of their
 * changes it hears of, as its settings say, and the message a batch of them
 * makes. Pure; ./feed sends it.
 */

import type { CliSessionEvent } from "../../../shared/cli/ui";
import type { ManagerNotify } from "../../../shared/manager/manager";
import { MANAGER_EVENTS_PREFIX } from "../../../shared/manager/prompt";
import { phaseOf } from "../agent-sessions/model";

/** How much of a session's last answer or question a report quotes. */
const MESSAGE_CHARS = 600;

/**
 * Whether the manager hears of a change: a session of its tasks that
 * finished, waits on someone, failed or closed; with "attention" also any
 * other that waits on the user or failed; with "all" any of those. Going to
 * work, a finished session being looked at, or a goal's change alone tells
 * nothing.
 */
export function reportable(event: CliSessionEvent, notify: ManagerNotify, task: boolean): boolean {
  // A goal's change alone leaves the state as the manager last heard it.
  if (event.from === event.to) return false;
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

/** A title on one line, whatever its agent made of it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
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
    // A title, which any program in a terminal may set, and what a session
    // says are quoted, each as one JSON string: they cannot pass for the
    // report's own words nor the app's.
    lines.push(
      `- ${JSON.stringify(clip(oneLine(event.title), 80))} ${stateLine(event.to)}: ${whatOf(event)} in ${ws} (${ids})${mine}`,
    );
    if (event.message) {
      lines.push(`  Last said (quoted): ${JSON.stringify(clip(event.message, MESSAGE_CHARS))}`);
    }
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

/**
 * Where a line's title, a JSON string from its opening quote at 2, ends:
 * the index of its closing quote; -1 when it does not.
 */
function quotedEnd(line: string): number {
  for (let i = 3; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === '"') return i;
  }
  return -1;
}

/**
 * A line's title and what follows it, as reportOf wrote them: a state with
 * no quote in it, then a colon. Null for a line of an older report.
 */
function splitTitle(line: string): { title: string; rest: string } | null {
  const end = quotedEnd(line);
  if (end < 0 || !/^ [^":]+: /.test(line.slice(end + 1))) return null;
  try {
    const title: unknown = JSON.parse(line.slice(2, end + 1));
    return typeof title === "string" ? { title, rest: line.slice(end + 1) } : null;
  } catch {
    return null;
  }
}

/** The sessions a report tells of, in its order. */
export function reportedSessions(text: string): ReportedSession[] {
  const sessions: ReportedSession[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith('- "')) continue;
    const split = splitTitle(line);
    if (split) {
      const entry = Object.entries(STATE_LINES).find(([, said]) =>
        split.rest.startsWith(` ${said}: `),
      );
      sessions.push({ title: split.title, state: entry?.[0] as ReportState | undefined });
      continue;
    }
    // A report made before titles were JSON strings: in quotes as they were.
    const entry = Object.entries(STATE_LINES).find(([, said]) => line.includes(`" ${said}: `));
    const close = entry ? line.indexOf(`" ${entry[1]}: `) : line.lastIndexOf('"');
    sessions.push({
      title: line.slice(3, close > 3 ? close : undefined),
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
