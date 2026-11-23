import type { GitSyncError } from "../../../../shared/git/types";
import { createDefaultSession, isStatusFetchingOperation } from "./session-defaults";
import { gitStoreErrorFromUnknown, isAbortError } from "./store-helpers";
import type { GitInFlightOp, GitOperationKind, GitSession } from "./types";

type SetState = (
  updater: (state: { sessions: Map<string, GitSession> }) => { sessions: Map<string, GitSession> },
) => void;
type GetState = () => { sessions: Map<string, GitSession> };

export interface GitStoreContext {
  set: SetState;
  get: GetState;
  controllers: Map<string, Map<AbortController, GitInFlightOp>>;
  isOperationLive: (workspaceId: string, ctrl: AbortController) => boolean;
  updateExistingSession: (
    workspaceId: string,
    updater: (session: GitSession) => GitSession,
  ) => void;
  upsertSession: (workspaceId: string, updater: (session: GitSession) => GitSession) => void;
  beginOperation: (workspaceId: string, kind: GitOperationKind) => AbortController;
  finishOperation: (workspaceId: string, kind: GitOperationKind, ctrl: AbortController) => void;
  failOperation: (
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
    error: unknown,
  ) => void;
  recordEnvelopeError: (workspaceId: string, kind: GitOperationKind, error: GitSyncError) => void;
  runOperation: <T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T | undefined>;
  runOperationStrict: <T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

export function createGitStoreContext(
  // biome-ignore lint/suspicious/noExplicitAny: zustand setState is typed via the store in git.ts
  set: (updater: (state: any) => any) => void,
  // biome-ignore lint/suspicious/noExplicitAny: zustand getState returns full GitState which extends sessions
  get: () => any,
): GitStoreContext {
  const controllers = new Map<string, Map<AbortController, GitInFlightOp>>();

  function isOperationLive(workspaceId: string, ctrl: AbortController): boolean {
    return controllers.get(workspaceId)?.has(ctrl) ?? false;
  }

  const typedSet: SetState = set;
  const typedGet: GetState = get;

  function updateExistingSession(
    workspaceId: string,
    updater: (session: GitSession) => GitSession,
  ): void {
    typedSet((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session) return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  function upsertSession(workspaceId: string, updater: (session: GitSession) => GitSession): void {
    typedSet((state) => {
      const session = state.sessions.get(workspaceId) ?? createDefaultSession();
      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  function beginOperation(workspaceId: string, kind: GitOperationKind): AbortController {
    const ctrl = new AbortController();
    const op: GitInFlightOp = { kind, startedAt: Date.now() };
    let running = controllers.get(workspaceId);
    if (!running) {
      running = new Map();
      controllers.set(workspaceId, running);
    }
    running.set(ctrl, op);

    upsertSession(workspaceId, (session) => {
      const preservePendingRetry = kind === "pull" || kind === "push";
      return {
        ...session,
        statusFetching: isStatusFetchingOperation(kind) ? true : session.statusFetching,
        inFlightOp: op,
        lastError: null,
        pendingNonFFRetry: preservePendingRetry ? session.pendingNonFFRetry : null,
      };
    });

    return ctrl;
  }

  function finishOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
  ): void {
    const running = controllers.get(workspaceId);
    if (!running?.delete(ctrl)) return;
    if (running.size === 0) controllers.delete(workspaceId);

    const remaining = [...running.values()];
    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind)
        ? remaining.some((op) => isStatusFetchingOperation(op.kind))
        : session.statusFetching,
      inFlightOp: remaining.at(-1) ?? null,
    }));
  }

  function failOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
    error: unknown,
  ): void {
    if (!isOperationLive(workspaceId, ctrl) || isAbortError(error)) return;

    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      lastError: gitStoreErrorFromUnknown(error, kind),
    }));
  }

  function recordEnvelopeError(
    workspaceId: string,
    kind: GitOperationKind,
    error: GitSyncError,
  ): void {
    updateExistingSession(workspaceId, (session) => ({
      ...session,
      lastError: {
        kind: error.kind,
        message: error.message,
        details: error.details,
        operation: kind,
      },
    }));
  }

  async function runOperation<T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const ctrl = beginOperation(workspaceId, kind);
    try {
      return await run(ctrl.signal);
    } catch (error) {
      failOperation(workspaceId, kind, ctrl, error);
      return undefined;
    } finally {
      finishOperation(workspaceId, kind, ctrl);
    }
  }

  async function runOperationStrict<T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ctrl = beginOperation(workspaceId, kind);
    try {
      return await run(ctrl.signal);
    } catch (error) {
      failOperation(workspaceId, kind, ctrl, error);
      throw error;
    } finally {
      finishOperation(workspaceId, kind, ctrl);
    }
  }

  return {
    set: typedSet,
    get: typedGet,
    controllers,
    isOperationLive,
    updateExistingSession,
    upsertSession,
    beginOperation,
    finishOperation,
    failOperation,
    recordEnvelopeError,
    runOperation,
    runOperationStrict,
  };
}
