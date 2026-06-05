// Shared PTY host interface used by agent-host and the IPC bridge.

type EventCallback = (args: unknown) => void;

/**
 * Minimal handle exposed by any PTY host implementation. Callers use `call` to
 * send RPCs and `on` to subscribe to push events (`data`, `exit`).
 */
export interface PtyHostHandle {
  call: (method: string, args: unknown) => Promise<unknown>;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
  /**
   * Terminates all active PTY sessions for the given workspace.
   * Called by `WorkspaceManager.remove()` before the workspace context is
   * deleted, so sessions are closed on the main side without any renderer
   * IPC round-trip. This prevents the renderer's post-removal `pty.kill`
   * calls from reaching a now-missing context and producing spurious
   * "workspace not found" errors.
   */
  closeWorkspaceSessions: (workspaceId: string) => void;
  /**
   * Called by manager after a successful re-authentication to restore held
   * sessions through the new channel. Acquires the new channel via
   * `tryGetAgentChannel`, subscribes to its lifecycle, and then runs the
   * session.list reconcile → replay / exit path.
   *
   * Must only be called when manager has confirmed the new SSH provider is
   * ready and the workspace context still exists.
   */
  restoreAfterReauth: (workspaceId: string) => Promise<void>;
  /**
   * Called by manager on every terminal failure path where re-authentication
   * will NOT be attempted (non-interactive auth, auth-cancelled, backoff
   * exhausted, ctx absent, explicit disconnect). Emits `pty.expired` + `pty.exit`
   * for every held session so no hold state leaks.
   *
   * No-op when the workspace has no held sessions.
   */
  releaseHeld: (workspaceId: string) => void;
}
