// Per-tab terminal recorder — 10 MB ring buffer.
// In-memory only; dump/load persistence is deferred until replay storage ships.

const MAX_RECORDER_DATA_SIZE = 10 * 1024 * 1024; // 10 MB

interface RecorderEntry {
  cols: number;
  rows: number;
  data: string[];
}

export interface ReplayEntry {
  cols: number;
  rows: number;
  data: string;
}

export interface ReplayEvent {
  events: ReplayEntry[];
}

/**
 * TerminalRecorder preserves PTY data and resize segments in the replay shape
 * already produced by the utility-process recorder.
 */
export class TerminalRecorder {
  private entries: RecorderEntry[];
  private totalDataLength = 0;

  constructor(cols: number, rows: number) {
    this.entries = [{ cols, rows, data: [] }];
  }

  /**
   * Records a terminal geometry change, collapsing consecutive empty resizes.
   */
  handleResize(cols: number, rows: number): void {
    if (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];
      if (last.data.length === 0) {
        this.entries.pop();
      }
    }

    if (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];
      if (last.cols === cols && last.rows === rows) {
        return;
      }
      if (last.cols === 0 && last.rows === 0) {
        last.cols = cols;
        last.rows = rows;
        return;
      }
    }

    this.entries.push({ cols, rows, data: [] });
  }

  /**
   * Appends decoded terminal output and trims the oldest data past the cap.
   */
  handleData(data: string): void {
    const last = this.entries[this.entries.length - 1];
    last.data.push(data);

    this.totalDataLength += data.length;

    while (this.totalDataLength > MAX_RECORDER_DATA_SIZE) {
      const first = this.entries[0];
      if (first.data.length === 0) {
        this.entries.shift();
        continue;
      }
      const remaining = this.totalDataLength - MAX_RECORDER_DATA_SIZE;
      if (remaining >= first.data[0].length) {
        this.totalDataLength -= first.data[0].length;
        first.data.shift();
        if (first.data.length === 0) {
          this.entries.shift();
        }
      } else {
        first.data[0] = first.data[0].substring(remaining);
        this.totalDataLength -= remaining;
      }
    }
  }

  /**
   * Returns the renderer replay event shape used by existing recorder output.
   */
  generateReplayEvent(): ReplayEvent {
    for (const entry of this.entries) {
      if (entry.data.length > 1) {
        entry.data = [entry.data.join("")];
      }
    }
    return {
      events: this.entries.map((e) => ({
        cols: e.cols,
        rows: e.rows,
        data: e.data[0] ?? "",
      })),
    };
  }

  /**
   * Reports the amount of retained data so cap tests can verify trimming.
   */
  getTotalDataLength(): number {
    return this.totalDataLength;
  }
}

export interface PtyRecorderSink {
  start(workspaceId: string, tabId: string, cols: number, rows: number): void;
  appendData(workspaceId: string, tabId: string, chunk: string): void;
  handleResize(workspaceId: string, tabId: string, cols: number, rows: number): void;
  stop(workspaceId: string, tabId: string): void;
}

/**
 * TerminalRecorderRegistry owns main-side recorders for agent-backed PTY tabs.
 */
export class TerminalRecorderRegistry implements PtyRecorderSink {
  private readonly recorders = new Map<string, TerminalRecorder>();

  /**
   * Starts or replaces the recorder for one workspace/tab session.
   */
  start(workspaceId: string, tabId: string, cols: number, rows: number): void {
    this.recorders.set(sessionKey(workspaceId, tabId), new TerminalRecorder(cols, rows));
  }

  /**
   * Appends decoded PTY output when a recorder exists for the session.
   */
  appendData(workspaceId: string, tabId: string, chunk: string): void {
    this.recorders.get(sessionKey(workspaceId, tabId))?.handleData(chunk);
  }

  /**
   * Records a resize for an active main-side recorder.
   */
  handleResize(workspaceId: string, tabId: string, cols: number, rows: number): void {
    this.recorders.get(sessionKey(workspaceId, tabId))?.handleResize(cols, rows);
  }

  /**
   * Stops tracking the in-memory recorder for a completed PTY session.
   */
  stop(workspaceId: string, tabId: string): void {
    this.recorders.delete(sessionKey(workspaceId, tabId));
  }

  /**
   * Returns the current replay event for tests and future dump consumers.
   */
  getReplayEvent(workspaceId: string, tabId: string): ReplayEvent | null {
    return this.recorders.get(sessionKey(workspaceId, tabId))?.generateReplayEvent() ?? null;
  }

  /**
   * Reports whether a session currently has a main-side recorder.
   */
  has(workspaceId: string, tabId: string): boolean {
    return this.recorders.has(sessionKey(workspaceId, tabId));
  }
}

/**
 * Builds the stable key used for main-side recorder lookup.
 */
function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}
