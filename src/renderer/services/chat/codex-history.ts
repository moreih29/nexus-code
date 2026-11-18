import type { CodexFork } from "../../../shared/types/layout";
import type { ChatTabState } from "./store";
import { compareVersions } from "./versions";

/** The oldest app-server whose turn-boundary fork we have verified. */
export const CODEX_HISTORY_VERSION = "0.170.0";

export function codexHistoryAvailable(version: string | null | undefined): boolean {
  return Boolean(version && compareVersions(version, CODEX_HISTORY_VERSION) >= 0);
}

export function codexHistoryBusy(state: ChatTabState): boolean {
  return (
    state.model.running ||
    state.model.permissions.length > 0 ||
    state.queue.length > 0 ||
    state.phase === "starting" ||
    Object.values(state.model.outgoing).some(({ subtype }) =>
      ["turn/start", "turn/steer", "review/start", "thread/compact/start", "thread/fork"].includes(
        subtype,
      ),
    )
  );
}

export function codexTurnIds(thread: unknown): string[] | undefined {
  const turns = (thread as { turns?: unknown } | undefined)?.turns;
  if (!Array.isArray(turns) || !turns.every((turn) => typeof turn?.id === "string")) return;
  return turns.map((turn) => turn.id);
}

export function codexForkPrefix(
  request: Pick<CodexFork, "beforeTurnId" | "lastTurnId">,
  source: readonly string[] | undefined,
): string[] | undefined {
  const boundary = request.beforeTurnId ?? request.lastTurnId;
  if (!boundary || !source) return;
  const index = source.indexOf(boundary);
  if (index < 0) return;
  return source.slice(0, index + (request.beforeTurnId ? 0 : 1));
}

/** A historical fork must have exactly the expected durable turn history. */
export function validCodexFork(
  request: Pick<CodexFork, "threadId" | "beforeTurnId" | "lastTurnId">,
  result: Record<string, unknown>,
  expected?: readonly string[],
): boolean {
  const thread = result.thread as { id?: unknown; turns?: { id?: unknown }[] } | undefined;
  if (typeof thread?.id !== "string" || thread.id === request.threadId) return false;
  if (!request.beforeTurnId && !request.lastTurnId) return true;
  const turns = codexTurnIds(thread);
  return Boolean(
    expected && turns?.length === expected.length && expected.every((id, i) => turns[i] === id),
  );
}
