/**
 * Git store context — shared primitives used by all slice creators.
 *
 * `createGitStoreContext` builds the single module-private `controllers` map
 * plus all session lifecycle helpers that need to close over it. Each slice
 * creator receives a `ctx` object rather than raw `set`/`get` so every slice
 * shares the same controllers map without importing module-level mutable state.
 *
 * The helpers here (updateExistingSession, upsertSession, beginOperation, etc.)
 * are verbatim from git.ts — structural move only, no behaviour change.
 */

import type { GitSyncError } from "../../../../shared/git/types";
import { gitStoreErrorFromUnknown, isAbortError } from "./store-helpers";
import { createDefaultSession, isStatusFetchingOperation } from "./session-defaults";
import type { GitOperationKind, GitSession } from "./types";

// ---------------------------------------------------------------------------
// Minimal session-map state shape shared by context and slice creators.
// Using `any` for the set/get callbacks avoids circular type dependency with
// the full GitState interface that is only defined in git.ts (the assembly).
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: zustand setState is typed via the store, not here
type SetState = (updater: (state: { sessions: Map<string, GitSession> }) => { sessions: Map<string, GitSession> }) => void;
type GetState = () => { sessions: Map<string, GitSession> };

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

export interface GitStoreContext {
  set: SetState;
  get: GetState;
  controllers: Map<string, AbortController>;
  updateExistingSession: (workspaceId: string, updater: (session: GitSession) => GitSession) => void;
  upsertSession: (workspaceId: string, updater: (session: GitSession) => GitSession) => void;
  beginOperation: (workspaceId: string, kind: GitOperationKind) => AbortController;
  finishOperation: (workspaceId: string, kind: GitOperationKind, ctrl: AbortController) => void;
  failOperation: (workspaceId: string, kind: GitOperationKind, ctrl: AbortController, error: unknown) => void;
  recordEnvelopeError: (workspaceId: string, kind: GitOperationKind, error: GitSyncError) => void;
  runOperation: <T>(workspaceId: string, kind: GitOperationKind, run: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
  runOperationStrict: <T>(workspaceId: string, kind: GitOperationKind, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitStoreContext(
  // biome-ignore lint/suspicious/noExplicitAny: zustand setState is typed via the store in git.ts
  set: (updater: (state: any) => any) => void,
  // biome-ignore lint/suspicious/noExplicitAny: zustand getState returns full GitState which extends sessions
  get: () => any,
): GitStoreContext {
  /** Single controllers map shared across all slices. */
  const controllers = new Map<string, AbortController>();

  const typedSet: SetState = set;
  const typedGet: GetState = get;

  /**
   * Update an existing session only. IPC broadcasts use this path so an
   * event for a workspace without an active session is dropped silently.
   */
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

  /**
   * Update a session, creating a default one first when a user action
   * arrives before the panel has been seeded.
   */
  function upsertSession(workspaceId: string, updater: (session: GitSession) => GitSession): void {
    typedSet((state) => {
      const session = state.sessions.get(workspaceId) ?? createDefaultSession();
      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  /**
   * Mark a workspace operation as running and replace any previous op
   * controller so cleanup can abort the current unit of work.
   */
  function beginOperation(workspaceId: string, kind: GitOperationKind): AbortController {
    const prior = controllers.get(workspaceId);
    if (prior) {
      prior.abort();
      controllers.delete(workspaceId);
    }

    const ctrl = new AbortController();
    controllers.set(workspaceId, ctrl);

    upsertSession(workspaceId, (session) => {
      const priorWasStatusFetch =
        session.inFlightOp?.kind === "refresh" || session.inFlightOp?.kind === "init";
      const preservePendingRetry = kind === "pull" || kind === "push";
      return {
        ...session,
        statusFetching: isStatusFetchingOperation(kind)
          ? true
          : priorWasStatusFetch
            ? false
            : session.statusFetching,
        inFlightOp: { kind, startedAt: Date.now() },
        lastError: null,
        pendingNonFFRetry: preservePendingRetry ? session.pendingNonFFRetry : null,
      };
    });

    return ctrl;
  }

  /**
   * Finish the current operation only when it still owns the workspace's
   * controller; stale promises from aborted operations are ignored.
   */
  function finishOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
  ): void {
    if (controllers.get(workspaceId) !== ctrl) return;

    controllers.delete(workspaceId);
    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      inFlightOp: null,
    }));
  }

  /**
   * Record an operation error on the matching session unless the operation
   * was superseded or intentionally aborted.
   */
  function failOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
    error: unknown,
  ): void {
    if (controllers.get(workspaceId) !== ctrl || isAbortError(error)) return;

    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      lastError: gitStoreErrorFromUnknown(error, kind),
    }));
  }

  /**
   * Preserve the normal inline error banner for operations that intentionally
   * return a typed failure envelope instead of rejecting the IPC call.
   */
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

  /**
   * Shared operation wrapper: set `inFlightOp`, run the typed IPC call,
   * normalize errors into state, then clear the operation on completion.
   */
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

  /**
   * Shared operation wrapper for branch flows whose caller needs to branch on
   * the typed error (for example unmerged delete → force-delete confirmation).
   * State still records the error before it is rethrown to the dialog owner.
   */
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
