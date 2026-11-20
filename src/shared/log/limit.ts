import type { Logger } from "./types";

type Level = "error" | "warn" | "info" | "debug";

/** How long a key stays quiet after it logs, unless the caller says otherwise. */
export const DEFAULT_LIMIT_INTERVAL_MS = 30_000;
/** How many keys one limiter tracks at once. */
export const MAX_LIMIT_KEYS = 200;

interface KeyState {
  /** When the key last wrote a line. */
  lastAt: number;
  /** Calls held back since then. */
  suppressed: number;
}

export interface LimitedLogger {
  /**
   * Writes the line unless the same key wrote one within the interval. The
   * first line after a quiet spell ends with "(N more)", N being the calls
   * held back meanwhile.
   */
  log(level: Level, key: string, msg: string): void;
}

export interface LimitOptions {
  intervalMs?: number;
  maxKeys?: number;
  now?: () => number;
}

/**
 * Wraps a logger so a line that repeats is written once per interval, with a
 * count of the ones left out. The key map stays under maxKeys: expired keys go
 * first, then the oldest.
 */
export function limitLog(logger: Logger, options: LimitOptions = {}): LimitedLogger {
  const intervalMs = options.intervalMs ?? DEFAULT_LIMIT_INTERVAL_MS;
  const maxKeys = options.maxKeys ?? MAX_LIMIT_KEYS;
  const now = options.now ?? Date.now;
  const keys = new Map<string, KeyState>();

  function makeRoom(at: number): void {
    if (keys.size < maxKeys) return;
    for (const [key, state] of keys) {
      if (at - state.lastAt >= intervalMs && state.suppressed === 0) keys.delete(key);
    }
    // Still full: drop the oldest first (a Map keeps insertion order).
    while (keys.size >= maxKeys) {
      const oldest = keys.keys().next();
      if (oldest.done) break;
      keys.delete(oldest.value);
    }
  }

  return {
    log(level, key, msg) {
      const at = now();
      const state = keys.get(key);
      if (state !== undefined && at - state.lastAt < intervalMs) {
        state.suppressed += 1;
        return;
      }
      const more = state?.suppressed ?? 0;
      if (state === undefined) makeRoom(at);
      else keys.delete(key); // re-insert so the order follows the last write
      keys.set(key, { lastAt: at, suppressed: 0 });
      logger[level](more > 0 ? `${msg} (${more} more)` : msg);
    },
  };
}

/** The first 8 characters of an id: enough to tell ids apart in a log. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Cuts text to at most max characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Replaces absolute paths in text with "<path>". Covers POSIX paths, Windows
 * drive and UNC paths, and ~/ paths. A bare name without a separator stays.
 */
export function stripPaths(text: string): string {
  return text
    .replace(/(?:\\\\|\/\/)[^\s"'`<>|:*?]+(?:[\\/][^\s"'`<>|:*?]+)+/g, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>|*?]*/g, "<path>")
    .replace(/(^|[\s"'`(=:])(?:~|\.{1,2})?(?:\/[^\s"'`<>|:*?)]+)+/g, "$1<path>");
}

/** The extension of a path (".ts"), or "" when it has none. Nothing else of it. */
export function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).slice(0, 12) : "";
}

/**
 * An error or message for a log line: credential-shaped values masked by the
 * caller's redactor, paths removed, one line, cut to max characters.
 */
export function safeText(
  text: string,
  max: number,
  redact: (text: string) => string = (t) => t,
): string {
  return truncate(stripPaths(redact(text)).replace(/\s+/g, " ").trim(), max);
}

/**
 * A stable 8-hex-digit tag for a value that must not appear in a log (a path,
 * a host, a distro name). The same value gets the same tag, so the lines of
 * one channel still line up; the value itself cannot be read back. A short
 * hash, not a secret: it keeps a name out of the log, it does not hide a guess.
 */
export function opaqueTag(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** An error's message for a log line: no credentials, no paths, one line, cut to max. */
export function errorText(
  error: unknown,
  max = 200,
  redact: (text: string) => string = (t) => t,
): string {
  return safeText(error instanceof Error ? error.message : String(error), max, redact);
}
