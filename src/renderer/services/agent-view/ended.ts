import type { EndedAgentSnapshot } from "../../../shared/types/agent-view";
import type { AgentSession } from "../agent-sessions/model";

export type ResumableAgent = "claude" | "codex";

export interface EndedAgent {
  readonly agent: ResumableAgent | undefined;
  readonly sessionId: string | undefined;
  readonly prompted: boolean;
}

export type SeenAgents = ReadonlyMap<string, EndedAgent>;

function resumable(agent: string | undefined): ResumableAgent | undefined {
  return agent === "claude" || agent === "codex" ? agent : undefined;
}

export function noteSeen(
  seen: SeenAgents,
  sessions: Iterable<AgentSession>,
  sessionIdOf: (key: string) => string | undefined,
  wasEnded?: ReadonlyMap<string, EndedAgent>,
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
      !wasEnded?.has(session.key) &&
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

export function withKept(seen: SeenAgents, kept: ReadonlyMap<string, EndedAgent>): SeenAgents {
  let next: Map<string, EndedAgent> | null = null;
  for (const [key, agent] of kept) {
    if (seen.has(key)) continue;
    next ??= new Map(seen);
    next.set(key, agent);
  }
  return next ?? seen;
}

export function endedToStore(
  ended: ReadonlyMap<string, EndedAgent>,
): Record<string, EndedAgentSnapshot> {
  const stored: Record<string, EndedAgentSnapshot> = {};
  for (const [key, { agent, sessionId, prompted }] of ended) {
    stored[key] = { ...(agent ? { agent } : {}), ...(sessionId ? { sessionId } : {}), prompted };
  }
  return stored;
}

export function endedFromStore(
  stored: Readonly<Record<string, EndedAgentSnapshot>> | undefined,
  held: ReadonlySet<string>,
): ReadonlyMap<string, EndedAgent> {
  const ended = new Map<string, EndedAgent>();
  for (const [key, { agent, sessionId, prompted }] of Object.entries(stored ?? {})) {
    if (held.has(key)) ended.set(key, { agent, sessionId, prompted });
  }
  return ended;
}

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

export function endedToRemove(
  ended: ReadonlyMap<string, EndedAgent>,
  inFront: (key: string) => boolean,
  shown: boolean,
): string[] {
  return [...ended.keys()].filter((key) => !shown || !inFront(key));
}

const SESSION_ID = /^[A-Za-z0-9-]+$/;

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
