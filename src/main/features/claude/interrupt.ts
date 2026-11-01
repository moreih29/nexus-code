/**
 * Claude Code runs no hook when the user interrupts a turn, so its state
 * would stay "running" until the next prompt. An interrupting key typed into
 * the terminal (Esc, or Ctrl-C from the keyboard or the sessions tab),
 * followed shortly by a sign from Claude that the turn ended, sets it back
 * to idle. Claude prints "Interrupted" once it has answered something; before
 * that it puts the prompt back in its input instead, and either way its
 * terminal title gets back the idle mark it shows between turns.
 */
import type { ClaudeStatusBroker } from "./status";

/** How long after the key Claude's sign counts. */
export const INTERRUPT_WINDOW_MS = 3_000;

/** The states a turn is in while it can be interrupted. */
const INTERRUPTIBLE = new Set(["running", "permissionPending"]);

/** The end of the output kept, since a chunk can end inside the sign. */
const TAIL_CHARS = 64;

/** CSI sequences, as styles, which can split the line's text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI sequences start with ESC
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** A terminal title (OSC 0 or 2) starting with the ✳ Claude shows between turns. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const IDLE_TITLE = /\x1b\][02];✳/;

/** Esc alone is the key; longer input starting with it is an escape sequence. */
function isInterruptKey(data: string): boolean {
  return data === "\x1b" || data.includes("\x03");
}

/**
 * The line Claude prints under the turn it stopped: "⎿  Interrupted · What
 * should Claude do instead?", or "⎿  Interrupted by user" in older versions.
 * Only that line counts, since a tool's output can say "Interrupted" too.
 */
const INTERRUPTED_LINE = /⎿\s+Interrupted(?: ·| by user)/;

function showsTurnEnded(output: string): boolean {
  return IDLE_TITLE.test(output) || INTERRUPTED_LINE.test(output.replace(CSI, ""));
}

export class ClaudeInterruptWatcher {
  /**
   * When each armed terminal's window closes, and the end of its output so
   * far, keyed by workspace and tab.
   */
  private readonly armed = new Map<string, { deadline: number; tail: string }>();

  constructor(
    private readonly broker: Pick<ClaudeStatusBroker, "get" | "set">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Input typed into a terminal. */
  noteInput(workspaceId: string, tabId: string, data: string): void {
    if (!isInterruptKey(data) || !this.interruptible(workspaceId, tabId)) return;
    this.armed.set(`${workspaceId}:${tabId}`, {
      deadline: this.now() + INTERRUPT_WINDOW_MS,
      tail: "",
    });
  }

  /** Output a terminal printed. */
  noteOutput(workspaceId: string, tabId: string, chunk: string): void {
    const key = `${workspaceId}:${tabId}`;
    const armed = this.armed.get(key);
    if (armed === undefined) return;
    if (this.now() > armed.deadline) {
      this.armed.delete(key);
      return;
    }
    const output = armed.tail + chunk;
    if (!showsTurnEnded(output)) {
      armed.tail = output.slice(-TAIL_CHARS);
      return;
    }
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
