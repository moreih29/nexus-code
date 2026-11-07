/**
 * An agent run in a terminal that ended while a panel held it: the terminal
 * stays, a shell again, which the agent view no longer lists. Its panel says
 * so and offers to take the conversation up again; once the user moves on
 * (another tab in front of the panel, or the workspaces) the terminal leaves
 * the panels, and stays in its workspace. Only an agent seen running this
 * run counts: a terminal not read yet reads as no agent at first. Pure.
 */

import type { AgentSession } from "../sessions/model";

export type ResumableAgent = "claude" | "codex";

export interface EndedAgent {
  /** The agent that ran, when it is one the panel can start again. */
  readonly agent: ResumableAgent | undefined;
  /** Claude's session, as its hooks told it. */
  readonly sessionId: string | undefined;
  /**
   * Whether the user prompted in that session. Claude Code keeps no
   * session the user quit before prompting, so none to take up by its id.
   */
  readonly prompted: boolean;
}

/** What is kept of each terminal's agent seen running, by session key. */
export type SeenAgents = ReadonlyMap<string, EndedAgent>;

function resumable(agent: string | undefined): ResumableAgent | undefined {
  return agent === "claude" || agent === "codex" ? agent : undefined;
}

/**
 * `seen` with the terminal agents among `sessions`, each with the session id
 * `sessionIdOf` tells, or the one told before. The same map when nothing is
 * new.
 */
export function noteSeen(
  seen: SeenAgents,
  sessions: Iterable<AgentSession>,
  sessionIdOf: (key: string) => string | undefined,
): SeenAgents {
  let next: Map<string, EndedAgent> | null = null;
  for (const session of sessions) {
    if (session.kind !== "terminal") continue;
    const before = seen.get(session.key);
    const agent = resumable(session.agent) ?? before?.agent;
    const sessionId = sessionIdOf(session.key) ?? before?.sessionId;
    const prompted =
      session.prompt !== undefined ||
      (before?.sessionId === sessionId && before?.prompted === true);
    if (
      before &&
      before.agent === agent &&
      before.sessionId === sessionId &&
      before.prompted === prompted
    ) {
      continue;
    }
    next ??= new Map(seen);
    next.set(session.key, { agent, sessionId, prompted });
  }
  return next ?? seen;
}

/**
 * The held terminals whose agent ended: seen running, no agent now, and
 * still an open terminal.
 */
export function endedAgents(
  held: readonly string[],
  seen: SeenAgents,
  isAgent: (key: string) => boolean,
  isOpenTerminal: (key: string) => boolean,
): ReadonlyMap<string, EndedAgent> {
  const ended = new Map<string, EndedAgent>();
  for (const key of held) {
    const agent = seen.get(key);
    if (agent && !isAgent(key) && isOpenTerminal(key)) ended.set(key, agent);
  }
  return ended;
}

/** Whether two reads tell the same ended agents. */
export function sameEnded(
  a: ReadonlyMap<string, EndedAgent>,
  b: ReadonlyMap<string, EndedAgent>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, agent] of a) {
    const other = b.get(key);
    if (
      !other ||
      other.agent !== agent.agent ||
      other.sessionId !== agent.sessionId ||
      other.prompted !== agent.prompted
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The ended agents the panels let go: those no panel has in front, and all
 * of them once the panels are not `shown`.
 */
export function endedToRemove(
  ended: ReadonlyMap<string, EndedAgent>,
  inFront: (key: string) => boolean,
  shown: boolean,
): string[] {
  return [...ended.keys()].filter((key) => !shown || !inFront(key));
}

/** A session id as Claude Code makes them, safe to type into a shell. */
const SESSION_ID = /^[A-Za-z0-9-]+$/;

/**
 * The line that takes the conversation up again in the terminal: Claude's
 * session by its id, once prompted in, else the picker of the directory's
 * sessions; Codex's picker. Null for an agent the panel cannot start again.
 */
export function resumeLine(ended: EndedAgent): string | null {
  if (ended.agent === "claude") {
    const id = ended.sessionId;
    return id && ended.prompted && SESSION_ID.test(id)
      ? `claude --resume ${id}`
      : "claude --resume";
  }
  if (ended.agent === "codex") return "codex resume";
  return null;
}
