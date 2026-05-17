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
}
