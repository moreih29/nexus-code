import { showsClaudeIdleTitle } from "./idle-title";
import type { ClaudeStatusBroker } from "./status";

export const INTERRUPT_WINDOW_MS = 3_000;

const INTERRUPTIBLE = new Set(["running", "permissionPending"]);

const TAIL_CHARS = 64;

function isInterruptKey(data: string): boolean {
  return data === "\x1b" || data.includes("\x03");
}

const HOLE = "\0";

const INTERRUPTED_LINES = [
  "Interrupted · What should Claude do instead?",
  "⎿  Interrupted by user",
];

const HOLES_ALLOWED = 1 / 4;

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

// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI sequences start with ESC
const CSI_AT = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const OSC_AT = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/y;

class RowReader {
  private cells: string[] = [];
  private col = 0;

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
    if (next !== undefined && "()*+".includes(next)) return at + 3;
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
  readonly deadline: number;
  readonly byTitle: boolean;
  tail: string;
  readonly rows: RowReader;
}

export class ClaudeInterruptWatcher {
  private readonly armed = new Map<string, Armed>();

  constructor(
    private readonly broker: Pick<ClaudeStatusBroker, "get" | "set">,
    private readonly now: () => number = Date.now,
  ) {}

  noteInput(workspaceId: string, tabId: string, data: string): void {
    const status = this.broker.get(workspaceId, tabId)?.status;
    if (status === undefined || !INTERRUPTIBLE.has(status)) return;
    const byKey = isInterruptKey(data);
    if (!byKey && status !== "permissionPending") return;
    this.armed.set(`${workspaceId}:${tabId}`, {
      deadline: this.now() + INTERRUPT_WINDOW_MS,
      byTitle: byKey,
      tail: "",
      rows: new RowReader(),
    });
  }

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
    if (armed.byTitle && showsClaudeIdleTitle(output)) return true;
    let shown = false;
    armed.rows.read(chunk, (row) => {
      shown ||= INTERRUPTED_LINES.some((line) => rowShows(row, line));
    });
    return shown;
  }

  forget(workspaceId: string, tabId: string): void {
    this.armed.delete(`${workspaceId}:${tabId}`);
  }

  private interruptible(workspaceId: string, tabId: string): boolean {
    const status = this.broker.get(workspaceId, tabId)?.status;
    return status !== undefined && INTERRUPTIBLE.has(status);
  }
}
