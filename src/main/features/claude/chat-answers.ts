// What a Claude tab tells of the permission requests it showed and the user
// answered there. Its program runs with -p and asks over its own stream, so
// no hook tells of the answer: the next one comes when the call allowed ends,
// which can be long.

type Listener = (workspaceId: string, tabId: string, stopped: boolean) => void;

export class ChatAnswers {
  private readonly listeners = new Set<Listener>();

  /**
   * The tab's last open request was answered; `stopped` when the answer
   * stopped the turn.
   */
  answered(workspaceId: string, tabId: string, stopped: boolean): void {
    for (const listener of this.listeners) listener(workspaceId, tabId, stopped);
  }

  onAnswered(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
