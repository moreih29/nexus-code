// Which Claude turn each tab is in, so hook frames of a turn that is over can
// be told apart.
//
// Claude Code runs each hook in its own process, and the frames race to the
// app: a turn's Stop or its late idle Notification can arrive after the next
// prompt's UserPromptSubmit. Every hook input carries prompt_id, the id of the
// user prompt it belongs to ("until the next prompt"), which gives the order
// the arrival does not.

/** How many finished turns a tab remembers; late frames come within seconds. */
const PAST_TURNS_KEPT = 16;
/** Keeps the late-hook guard bounded even when every session used a different tab. */
const ENDED_TABS_KEPT = 512;

interface TabTurns {
  /** The prompt id of the turn under way, if any frame has told it yet. */
  current?: string;
  /** Prompt ids of turns that are over, oldest first. */
  past: string[];
}

export class TurnOrder {
  private readonly tabs = new Map<string, TabTurns>();
  private readonly ended = new Set<string>();

  /**
   * Records a frame and says whether it belongs to a turn that is already
   * over. Frames without a prompt id (Claude Code versions before it) are
   * never stale.
   */
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
      // Only a prompt starts a turn. Another frame with an id not seen yet is
      // let through without moving on: it may as well be a late one of a turn
      // whose prompt came before the app was listening.
      this.retire(tab);
      tab.current = promptId;
    }
    return false;
  }

  /** An identified stream result must belong to the current prompt. */
  acceptsResult(workspaceId: string, tabId: string, promptId: string | undefined): boolean {
    if (!promptId) return true;
    const tab = this.tabs.get(`${workspaceId}:${tabId}`);
    return !tab?.past.includes(promptId) && (!tab?.current || tab.current === promptId);
  }

  /** The session ended: frames of its last turn that still come are stale. */
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
