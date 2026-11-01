/**
 * What each browser tab's pages printed to the console, kept from the tab's
 * start for nexus browser console, with a line for each page it loaded.
 */
import type { WebContents } from "electron";

export type ConsoleLevel = "debug" | "info" | "warning" | "error";

export interface ConsoleEntry {
  readonly at: number;
  /** "page" marks a page load; the text is its URL. */
  readonly level: ConsoleLevel | "page";
  readonly text: string;
  /** Where it was printed from, as "url:line". */
  readonly source?: string;
}

/** How many entries a tab keeps; older ones go first. */
export const CONSOLE_LIMIT = 500;

const LEVELS: readonly ConsoleLevel[] = ["debug", "info", "warning", "error"];

/** Electron's console-message details; older versions passed the level as a number. */
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

  /** The entries so far; with `clear`, forgets them. */
  read(clear: boolean): readonly ConsoleEntry[] {
    const entries = this.entries;
    if (clear) this.entries = [];
    return entries;
  }
}

/** Starts a log for `contents`, filled until it is destroyed. */
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
