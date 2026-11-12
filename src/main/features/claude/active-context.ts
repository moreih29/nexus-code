// Caches in main the (workspaceId, tabId) context the user is currently looking at.
//
// Each time the renderer changes the active tab it pushes it via the claude.setActiveContext IPC,
// and main reads this value when handling a Stop hook to decide whether to fire a notification.
//
// Single-source principle: the renderer writes, main is read-only.

export interface ActiveContext {
  workspaceId: string;
  tabId: string;
}

/**
 * A simple store that holds the active context in the main process.
 *
 * It is a one-way renderer → main push model, so there is no listener / broadcast feature.
 * The Stop hook handler calls get() synchronously to compare.
 */
export class ActiveContextStore {
  private current: ActiveContext | null = null;

  /** Updates the active context. When both are null, sets "no active context". */
  set(workspaceId: string | null, tabId: string | null): void {
    if (workspaceId === null || tabId === null) {
      this.current = null;
      return;
    }
    this.current = { workspaceId, tabId };
  }

  /** The current active context, or null. */
  get(): ActiveContext | null {
    return this.current;
  }

  /**
   * Checks whether the given (workspaceId, tabId) is currently active.
   * Always false when there is no active context.
   */
  isActive(workspaceId: string, tabId: string): boolean {
    const c = this.current;
    return c !== null && c.workspaceId === workspaceId && c.tabId === tabId;
  }
}
