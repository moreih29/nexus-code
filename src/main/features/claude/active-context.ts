export interface ActiveContext {
  workspaceId: string;
  tabId: string;
}

export class ActiveContextStore {
  private current: ActiveContext | null = null;

  set(workspaceId: string | null, tabId: string | null): void {
    if (workspaceId === null || tabId === null) {
      this.current = null;
      return;
    }
    this.current = { workspaceId, tabId };
  }

  get(): ActiveContext | null {
    return this.current;
  }

  isActive(workspaceId: string, tabId: string): boolean {
    const c = this.current;
    return c !== null && c.workspaceId === workspaceId && c.tabId === tabId;
  }
}
