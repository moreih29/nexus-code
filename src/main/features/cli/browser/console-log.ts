import type { WebContents } from "electron";

export type ConsoleLevel = "debug" | "info" | "warning" | "error";

export interface ConsoleEntry {
  readonly at: number;
  readonly level: ConsoleLevel | "page";
  readonly text: string;
  readonly source?: string;
}

export const CONSOLE_LIMIT = 500;

const LEVELS: readonly ConsoleLevel[] = ["debug", "info", "warning", "error"];

interface ConsoleMessageEvent {
  readonly level?: unknown;
  readonly message?: unknown;
  readonly lineNumber?: unknown;
  readonly sourceId?: unknown;
}

function levelOf(level: unknown): ConsoleLevel {
  if (typeof level === "number") return LEVELS[level] ?? "info";
  return LEVELS.includes(level as ConsoleLevel) ? (level as ConsoleLevel) : "info";
}

export class ConsoleLog {
  private entries: ConsoleEntry[] = [];

  add(entry: ConsoleEntry): void {
    this.entries.push(entry);
    if (this.entries.length > CONSOLE_LIMIT)
      this.entries.splice(0, this.entries.length - CONSOLE_LIMIT);
  }

  read(clear: boolean): readonly ConsoleEntry[] {
    const entries = this.entries;
    if (clear) this.entries = [];
    return entries;
  }
}

export function watchConsole(contents: WebContents, now: () => number = Date.now): ConsoleLog {
  const log = new ConsoleLog();
  contents.on("console-message", (event: ConsoleMessageEvent, ...legacy: unknown[]) => {
    const message = event.message ?? legacy[1];
    const line = event.lineNumber ?? legacy[2];
    const sourceId = event.sourceId ?? legacy[3];
    log.add({
      at: now(),
      level: levelOf(event.level ?? legacy[0]),
      text: String(message ?? ""),
      ...(typeof sourceId === "string" && sourceId !== ""
        ? { source: `${sourceId}:${String(line ?? 0)}` }
        : {}),
    });
  });
  contents.on("did-navigate", (_event: unknown, url: string) => {
    log.add({ at: now(), level: "page", text: url });
  });
  return log;
}
