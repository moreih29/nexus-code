import type { Logger } from "./types";

type Level = "error" | "warn" | "info" | "debug";

export const DEFAULT_LIMIT_INTERVAL_MS = 30_000;
export const MAX_LIMIT_KEYS = 200;

interface KeyState {
  lastAt: number;
  suppressed: number;
}

export interface LimitedLogger {
  log(level: Level, key: string, msg: string): void;
}

export interface LimitOptions {
  intervalMs?: number;
  maxKeys?: number;
  now?: () => number;
}

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
      else keys.delete(key);
      keys.set(key, { lastAt: at, suppressed: 0 });
      logger[level](more > 0 ? `${msg} (${more} more)` : msg);
    },
  };
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function stripPaths(text: string): string {
  return text
    .replace(/(?:\\\\|\/\/)[^\s"'`<>|:*?]+(?:[\\/][^\s"'`<>|:*?]+)+/g, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>|*?]*/g, "<path>")
    .replace(/(^|[\s"'`(=:])(?:~|\.{1,2})?(?:\/[^\s"'`<>|:*?)]+)+/g, "$1<path>");
}

export function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).slice(0, 12) : "";
}

export function safeText(
  text: string,
  max: number,
  redact: (text: string) => string = (t) => t,
): string {
  return truncate(stripPaths(redact(text)).replace(/\s+/g, " ").trim(), max);
}

export function opaqueTag(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function errorText(
  error: unknown,
  max = 200,
  redact: (text: string) => string = (t) => t,
): string {
  return safeText(error instanceof Error ? error.message : String(error), max, redact);
}
