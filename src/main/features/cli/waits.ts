/**
 * Which terminals are waiting on which, for the app's sessions view: a wait
 * is listed from when nexus terminal wait (or terminal send --wait) starts
 * until it ends, or until the waiting terminal exits.
 */
import type { TerminalRef, TerminalWait } from "../../../shared/sessions/agent-state";
import type { ActivitySource } from "./activity";

export class WaitRegistry {
  private readonly waits = new Set<TerminalWait>();
  private readonly disposers: Array<() => void> = [];

  constructor(source?: ActivitySource) {
    if (!source) return;
    this.disposers.push(
      source.on("exit", (args) => {
        const { workspaceId, tabId } = args as TerminalRef;
        for (const wait of this.waits) {
          if (wait.waiter.workspaceId === workspaceId && wait.waiter.tabId === tabId) {
            this.waits.delete(wait);
          }
        }
      }),
    );
  }

  /** Lists `waiter` as waiting on `target`; the returned function ends it. */
  begin(waiter: TerminalRef, target: TerminalRef, since: number): () => void {
    const wait: TerminalWait = {
      waiter: { workspaceId: waiter.workspaceId, tabId: waiter.tabId },
      target: { workspaceId: target.workspaceId, tabId: target.tabId },
      since,
    };
    this.waits.add(wait);
    return () => {
      this.waits.delete(wait);
    };
  }

  snapshot(): TerminalWait[] {
    return [...this.waits];
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.waits.clear();
  }
}
