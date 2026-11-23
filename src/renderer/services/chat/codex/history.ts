import type { CodexFork } from "../../../../shared/types/layout";
import type { ChatTabState } from "../store";
import { compareVersions } from "../versions";
import type { CodexModel } from "./model";

export const CODEX_HISTORY_VERSION = "0.170.0";

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

export interface CodexThreadPages {
  turns: unknown[];
  nextCursor: string | null | undefined;
  cursors: string[];
}

export function emptyCodexThreadPages(): CodexThreadPages {
  return { turns: [], nextCursor: undefined, cursors: [] };
}

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

export const THREAD_READ_TURNS = 50;
export const THREAD_READ_PAGES = 200;

export async function readCodexThread(
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  threadId: string,
  version: string | null | undefined,
): Promise<{ id: string; turns: unknown[] } | null> {
  if (!codexHistoryAvailable(version)) {
    const result = await request("thread/read", { threadId, includeTurns: true });
    const turns = (result.thread as { turns?: unknown } | undefined)?.turns;
    return Array.isArray(turns) ? { id: threadId, turns } : null;
  }
  let pages = emptyCodexThreadPages();
  for (let page = 0; page < THREAD_READ_PAGES; page++) {
    const cursor = pages.nextCursor;
    const result = await request("thread/turns/list", {
      threadId,
      sortDirection: "asc",
      itemsView: "full",
      limit: THREAD_READ_TURNS,
      ...(cursor ? { cursor } : {}),
    });
    const next = appendCodexThreadPage(pages, result);
    if (!next) return null;
    if (next.nextCursor === null) return { id: threadId, turns: next.turns };
    pages = next;
  }
  return null;
}
