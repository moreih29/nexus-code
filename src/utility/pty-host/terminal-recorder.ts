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

export class TerminalRecorder {
  private entries: RecorderEntry[];
  private totalDataLength = 0;

  constructor(cols: number, rows: number) {
    this.entries = [{ cols, rows, data: [] }];
  }

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

  getTotalDataLength(): number {
    return this.totalDataLength;
  }
}
