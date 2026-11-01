/**
 * Claude Code runs no hook when the user interrupts a turn, so its state
 * would stay "running" until the next prompt. An interrupting key typed into
 * the terminal (Esc, or Ctrl-C from the keyboard or the sessions tab),
 * followed shortly by Claude's "Interrupted" line, sets it back to idle.
 */
import type { ClaudeStatusBroker } from "./status";

/** How long after the key Claude's "Interrupted" line counts. */
export const INTERRUPT_WINDOW_MS = 3_000;

/** The states a turn is in while it can be interrupted. */
const INTERRUPTIBLE = new Set(["running", "permissionPending"]);

/** CSI sequences, as styles, which can split the line's text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI sequences start with ESC
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Esc alone is the key; longer input starting with it is an escape sequence. */
function isInterruptKey(data: string): boolean {
  return data === "\x1b" || data.includes("\x03");
}

export class ClaudeInterruptWatcher {
  /** When each armed terminal's window closes, keyed by workspace and tab. */
  private readonly armed = new Map<string, number>();

  constructor(
    private readonly broker: Pick<ClaudeStatusBroker, "get" | "set">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Input typed into a terminal. */
  noteInput(workspaceId: string, tabId: string, data: string): void {
    if (!isInterruptKey(data) || !this.interruptible(workspaceId, tabId)) return;
    this.armed.set(`${workspaceId}:${tabId}`, this.now() + INTERRUPT_WINDOW_MS);
  }

  /** Output a terminal printed. */
  noteOutput(workspaceId: string, tabId: string, chunk: string): void {
    const key = `${workspaceId}:${tabId}`;
    const deadline = this.armed.get(key);
    if (deadline === undefined) return;
    if (this.now() > deadline) {
      this.armed.delete(key);
      return;
    }
    if (!chunk.replace(CSI, "").includes("Interrupted")) return;
    this.armed.delete(key);
    if (this.interruptible(workspaceId, tabId)) this.broker.set(workspaceId, tabId, "idle");
  }

  /** Forgets a terminal that ended. */
  forget(workspaceId: string, tabId: string): void {
    this.armed.delete(`${workspaceId}:${tabId}`);
  }

  private interruptible(workspaceId: string, tabId: string): boolean {
    const status = this.broker.get(workspaceId, tabId)?.status;
    return status !== undefined && INTERRUPTIBLE.has(status);
  }
}
