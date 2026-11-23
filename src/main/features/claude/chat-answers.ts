type Listener = (workspaceId: string, tabId: string, stopped: boolean) => void;

export class ChatAnswers {
  private readonly listeners = new Set<Listener>();

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
