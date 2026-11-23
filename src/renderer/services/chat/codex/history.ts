import type { CodexFork } from "../../../../shared/types/layout";
import type { ChatTabState } from "../store";
import { compareVersions } from "../versions";
import type { CodexModel } from "./model";

/** The oldest app-server whose turn-boundary fork we have verified. */
export const CODEX_HISTORY_VERSION = "0.170.0";

/** The running server's version, falling back to the detected executable. */
export function codexServerVersion(
  model: Pick<CodexModel, "appServerVersion">,
  installedVersion: string | null | undefined,
): string | null | undefined {
  return model.appServerVersion ?? installedVersion;
}

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

function turnIds(turns: unknown): string[] | undefined {
  if (!Array.isArray(turns) || !turns.every((turn) => typeof turn?.id === "string" && turn.id))
    return;
  return turns.map((turn) => turn.id);
}

export function codexTurnIds(thread: unknown): string[] | undefined {
  return turnIds((thread as { turns?: unknown } | undefined)?.turns);
}

/** A thread's turns with their items so far, read a page at a time (thread/turns/list). */
export interface CodexThreadPages {
  turns: unknown[];
  /** The next page's cursor; undefined before the first, null after the last. */
  nextCursor: string | null | undefined;
  cursors: string[];
}

export function emptyCodexThreadPages(): CodexThreadPages {
  return { turns: [], nextCursor: undefined, cursors: [] };
}

/**
 * The pages with the next one's turns, or undefined where the chain breaks:
 * no turns listed, an empty page that goes on, or a cursor seen before.
 */
export function appendCodexThreadPage(
  previous: CodexThreadPages,
  result: Record<string, unknown>,
): CodexThreadPages | undefined {
  if (previous.nextCursor === null || !Array.isArray(result.data)) return;
  const nextCursor = result.nextCursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      !nextCursor ||
      result.data.length === 0 ||
      previous.cursors.includes(nextCursor))
  )
    return;
  return {
    turns: [...previous.turns, ...result.data],
    nextCursor,
    cursors: nextCursor === null ? previous.cursors : [...previous.cursors, nextCursor],
  };
}

/** Fork preflight needs ordered turn IDs, without the items in each turn. */
export interface CodexForkPages {
  turns: string[];
  nextCursor: string | null | undefined;
  cursors: string[];
}

export function emptyCodexForkPages(): CodexForkPages {
  return { turns: [], nextCursor: undefined, cursors: [] };
}

export function appendCodexForkPage(
  previous: CodexForkPages,
  cursor: unknown,
  result: Record<string, unknown>,
): CodexForkPages | undefined {
  if (previous.nextCursor === null || cursor !== previous.nextCursor) return;
  const ids = turnIds(result.data);
  const nextCursor = result.nextCursor;
  if (
    !ids ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        !nextCursor ||
        ids.length === 0 ||
        previous.cursors.includes(nextCursor)))
  )
    return;
  const turns = [...previous.turns, ...ids];
  if (new Set(turns).size !== turns.length) return;
  return {
    turns,
    nextCursor,
    cursors: nextCursor === null ? previous.cursors : [...previous.cursors, nextCursor],
  };
}

export function codexForkSourceStatus(
  threadId: string,
  result: Record<string, unknown>,
): string | undefined {
  const thread = result.thread as { id?: unknown; status?: { type?: unknown } } | undefined;
  if (thread?.id !== threadId) return;
  const status = thread.status?.type;
  if (
    status === "idle" ||
    status === "notLoaded" ||
    status === "active" ||
    status === "systemError"
  ) {
    return status;
  }
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
