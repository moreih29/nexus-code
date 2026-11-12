/**
 * Claude Code runs no hook when the user interrupts a turn, so its state
 * would stay "running" until the next prompt. An interrupting key typed into
 * the terminal (Esc, or Ctrl-C from the keyboard or the agent list),
 * followed shortly by a sign from Claude that the turn ended, sets it back
 * to idle. Claude prints "Interrupted" once it has answered something; before
 * that it puts the prompt back in its input instead, and either way its
 * terminal title gets back the idle mark it shows between turns.
 *
 * Denying a permission dialog of the session's own turn ("No", picked with
 * any key) interrupts the turn the same way, and no hook tells it either.
 * The dialog's title already shows the idle mark, so there only the line
 * counts.
 */
import type { ClaudeStatusBroker } from "./status";

/** How long after the key Claude's sign counts. */
export const INTERRUPT_WINDOW_MS = 3_000;

/** The states a turn is in while it can be interrupted. */
const INTERRUPTIBLE = new Set(["running", "permissionPending"]);

/** The end of the output kept, since a chunk can end inside a title. */
const TAIL_CHARS = 64;

/** A terminal title (OSC 0 or 2) starting with the ✳ Claude shows between turns. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const IDLE_TITLE = /\x1b\][02];✳/;

/** Esc alone is the key; longer input starting with it is an escape sequence. */
function isInterruptKey(data: string): boolean {
  return data === "\x1b" || data.includes("\x03");
}

/** A cell output moved the cursor over instead of writing it. */
const HOLE = "\0";

/**
 * The lines Claude prints under the turn it stopped: "⎿  Interrupted · What
 * should Claude do instead?", or "⎿  Interrupted by user" in older versions.
 * Only those lines count, since a tool's output can say "Interrupted" too.
 */
const INTERRUPTED_LINES = [
  "Interrupted · What should Claude do instead?",
  "⎿  Interrupted by user",
];

/** How many of a line's cells can be holes for it to still count. */
const HOLES_ALLOWED = 1 / 4;

/** Whether `row` shows `line`, a hole standing for any cell. */
function rowShows(row: string, line: string): boolean {
  const cells = Array.from(row);
  const want = Array.from(line);
  for (let at = 0; at + want.length <= cells.length; at++) {
    let holes = 0;
    let i = 0;
    for (; i < want.length; i++) {
      const cell = cells[at + i];
      if (cell === HOLE) holes++;
      else if (cell !== want[i] && !(want[i] === " " && cell === "\u00a0")) break;
    }
    if (i === want.length && holes <= want.length * HOLES_ALLOWED) return true;
  }
  return false;
}

/** A CSI sequence: parameters, intermediates, final. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI sequences start with ESC
const CSI_AT = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
/** An OSC sequence, ended by BEL or ST. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const OSC_AT = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/y;

/**
 * The text output writes on the row its cursor is on. A redraw writes only
 * the cells that change and moves the cursor over the rest, so a line comes
 * with holes where it shows what was there already: blanks, and letters too.
 */
class RowReader {
  private cells: string[] = [];
  private col = 0;

  /** Reads `chunk`, telling each row it wrote on as it leaves it, and the last. */
  read(chunk: string, onRow: (row: string) => void): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === "\x1b") {
        i = this.escape(chunk, i, onRow);
        continue;
      }
      i++;
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") this.newRow(onRow, this.col);
      else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch >= " " && ch !== "\x7f") this.write(ch);
    }
    onRow(this.text());
  }

  private escape(chunk: string, at: number, onRow: (row: string) => void): number {
    CSI_AT.lastIndex = at;
    const csi = CSI_AT.exec(chunk);
    if (csi) {
      this.csi(csi[1], csi[2], onRow);
      return CSI_AT.lastIndex;
    }
    OSC_AT.lastIndex = at;
    if (OSC_AT.exec(chunk)) return OSC_AT.lastIndex;
    const next = chunk[at + 1];
    // A charset choice, as ESC ( B, takes one more character.
    if (next !== undefined && "()*+".includes(next)) return at + 3;
    // Restoring a saved cursor, or a reverse index, moves it to another row.
    if (next === "8" || next === "M") this.newRow(onRow, 0);
    return at + 2;
  }

  private csi(params: string, final: string, onRow: (row: string) => void): void {
    const [first, second] = params.split(";").map((n) => Number.parseInt(n, 10) || 1);
    switch (final) {
      case "G":
      case "`":
        this.col = (first ?? 1) - 1;
        break;
      case "C":
        this.col += first ?? 1;
        break;
      case "D":
        this.col = Math.max(0, this.col - (first ?? 1));
        break;
      case "A":
      case "B":
      case "d":
        this.newRow(onRow, this.col);
        break;
      case "E":
      case "F":
        this.newRow(onRow, 0);
        break;
      case "H":
      case "f":
        this.newRow(onRow, (second ?? 1) - 1);
        break;
      case "K":
        // Erasing to the end of the line, or all of it.
        if (params === "2") this.cells = [];
        else if (params === "" || params === "0") this.cells.splice(this.col);
        break;
      default:
        break;
    }
  }

  private write(ch: string): void {
    for (let i = this.cells.length; i < this.col; i++) this.cells[i] = HOLE;
    this.cells[this.col++] = ch;
  }

  private newRow(onRow: (row: string) => void, col: number): void {
    onRow(this.text());
    this.cells = [];
    this.col = col;
  }

  private text(): string {
    return Array.from(this.cells, (cell) => cell ?? HOLE).join("");
  }
}

interface Armed {
  /** When the window closes. */
  readonly deadline: number;
  /** Whether Claude's idle title counts as the sign, as for an interrupting key. */
  readonly byTitle: boolean;
  /** The end of the output so far, for a title split between chunks. */
  tail: string;
  readonly rows: RowReader;
}

export class ClaudeInterruptWatcher {
  /** Each armed terminal's window and what it has printed since, keyed by workspace and tab. */
  private readonly armed = new Map<string, Armed>();

  constructor(
    private readonly broker: Pick<ClaudeStatusBroker, "get" | "set">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Input typed into a terminal. */
  noteInput(workspaceId: string, tabId: string, data: string): void {
    const status = this.broker.get(workspaceId, tabId)?.status;
    if (status === undefined || !INTERRUPTIBLE.has(status)) return;
    const byKey = isInterruptKey(data);
    // At a permission dialog any key can pick "No".
    if (!byKey && status !== "permissionPending") return;
    this.armed.set(`${workspaceId}:${tabId}`, {
      deadline: this.now() + INTERRUPT_WINDOW_MS,
      byTitle: byKey,
      tail: "",
      rows: new RowReader(),
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
    if (!this.showsTurnEnded(armed, chunk)) return;
    this.armed.delete(key);
    if (this.interruptible(workspaceId, tabId)) this.broker.set(workspaceId, tabId, "idle");
  }

  private showsTurnEnded(armed: Armed, chunk: string): boolean {
    const output = armed.tail + chunk;
    armed.tail = output.slice(-TAIL_CHARS);
    if (armed.byTitle && IDLE_TITLE.test(output)) return true;
    let shown = false;
    armed.rows.read(chunk, (row) => {
      shown ||= INTERRUPTED_LINES.some((line) => rowShows(row, line));
    });
    return shown;
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
