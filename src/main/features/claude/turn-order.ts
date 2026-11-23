const PAST_TURNS_KEPT = 16;
const ENDED_TABS_KEPT = 512;

interface TabTurns {
  current?: string;
  past: string[];
}

export class TurnOrder {
  private readonly tabs = new Map<string, TabTurns>();
  private readonly ended = new Set<string>();

  isStale(
    workspaceId: string,
    tabId: string,
    subcommand: string,
    promptId: string | undefined,
  ): boolean {
    if (promptId === undefined) return false;
    const key = `${workspaceId}:${tabId}`;
    let tab = this.tabs.get(key);
    if (tab?.past.includes(promptId)) return true;
    this.ended.delete(key);
    if (!tab) {
      tab = { past: [] };
      this.tabs.set(key, tab);
    }
    if (tab.current === undefined) {
      tab.current = promptId;
    } else if (subcommand === "user-prompt-submit" && tab.current !== promptId) {
      this.retire(tab);
      tab.current = promptId;
    }
    return false;
  }

  acceptsResult(workspaceId: string, tabId: string, promptId: string | undefined): boolean {
    if (!promptId) return true;
    const tab = this.tabs.get(`${workspaceId}:${tabId}`);
    return !tab?.past.includes(promptId) && (!tab?.current || tab.current === promptId);
  }

  end(workspaceId: string, tabId: string): void {
    const key = `${workspaceId}:${tabId}`;
    const tab = this.tabs.get(key);
    if (!tab || this.ended.has(key)) return;
    this.retire(tab);
    this.ended.add(key);
    if (this.ended.size <= ENDED_TABS_KEPT) return;
    const oldest = this.ended.values().next().value;
    if (oldest !== undefined) {
      this.ended.delete(oldest);
      this.tabs.delete(oldest);
    }
  }

  private retire(tab: TabTurns): void {
    if (tab.current === undefined) return;
    tab.past.push(tab.current);
    if (tab.past.length > PAST_TURNS_KEPT) tab.past.shift();
    tab.current = undefined;
  }
}
