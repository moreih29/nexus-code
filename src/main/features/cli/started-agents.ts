import type { ActivitySource } from "./activity";

export const FIRST_TURN_GRACE_MS = 60_000;

interface TerminalRef {
  readonly workspaceId: string;
  readonly tabId: string;
}

export class StartedAgents {
  private readonly startedAt = new Map<string, number>();
  private readonly disposers: Array<() => void> = [];

  constructor(source?: ActivitySource) {
    if (!source) return;
    this.disposers.push(
      source.on("exit", (args) => {
        this.startedAt.delete(keyOf(args as TerminalRef));
      }),
    );
  }

  mark(terminal: TerminalRef, at: number): void {
    this.startedAt.set(keyOf(terminal), at);
  }

  since(terminal: TerminalRef, now: number): number | undefined {
    const key = keyOf(terminal);
    const at = this.startedAt.get(key);
    if (at === undefined) return undefined;
    if (now - at < FIRST_TURN_GRACE_MS) return at;
    this.startedAt.delete(key);
    return undefined;
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.startedAt.clear();
  }
}

function keyOf(terminal: TerminalRef): string {
  return `${terminal.workspaceId}:${terminal.tabId}`;
}
