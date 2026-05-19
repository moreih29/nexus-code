/**
 * Main-process logging facade built on electron-log v5.
 *
 * Configures two transports:
 *   - file  → JSON lines written to `<logs>/main.log` (level: debug)
 *   - console → human-readable text (level: info)
 *
 * Call `initMainLogger()` once at the top of `src/main/index.ts` before
 * any window is created.  Afterwards use `createLogger(source)` to obtain
 * a bound logger for a given subsystem.
 *
 * electron-log and Electron are loaded lazily (inside function bodies) so
 * that merely importing this module does not trigger their load-time side
 * effects — which crash the bun test runner where `electron` is mocked and
 * `electron-log/main` has no valid app context.
 */

import type { Logger, LogMeta, LogSource, NxLogMeta } from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the structured envelope that the file-transport format reads.
 * Using a sentinel key keeps the approach forward-compatible: the format
 * function strips it before writing, so consumer code never sees the field.
 */
function buildMeta(source: LogSource | string, meta?: LogMeta): NxLogMeta {
  return {
    __nx_log: true,
    source,
    ...(meta?.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Transport configuration (called once from initMainLogger)
// ---------------------------------------------------------------------------

/**
 * Installs a file-transport format that emits one JSON object per line.
 * The envelope inserted by `buildMeta` is stripped from `data` so that
 * only the human-readable message text remains in the `msg` field.
 */
function configureFileTransport(
  log: { transports: { file: Record<string, unknown> } },
  logsDir: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");

  const fileTransport = log.transports.file as {
    resolvePathFn: unknown;
    level: string;
    format: unknown;
  };

  fileTransport.resolvePathFn = () => nodePath.join(logsDir, "main.log");
  fileTransport.level = "debug";

  fileTransport.format = ({ message }: { message: { date: Date; level: string; data: unknown[]; variables?: Record<string, string> } }) => {
    const [head, ...rest] = message.data;

    let source: string = message.variables?.processType ?? "main";
    let correlationId: string | undefined;
    let msgParts: unknown[] = [head, ...rest];

    if (
      head !== null &&
      typeof head === "object" &&
      (head as Record<string, unknown>).__nx_log === true
    ) {
      const env = head as NxLogMeta;
      source = env.source;
      correlationId = env.correlationId;
      msgParts = rest;
    }

    const entry: Record<string, unknown> = {
      ts: message.date.toISOString(),
      level: message.level,
      source,
      msg: msgParts.length === 1 && typeof msgParts[0] === "string" ? msgParts[0] : msgParts,
    };

    if (correlationId !== undefined) {
      entry.correlationId = correlationId;
    }

    return [JSON.stringify(entry)];
  };
}

/**
 * Installs a console-transport format that produces human-readable lines
 * and strips the internal envelope from the visible output.
 */
function configureConsoleTransport(log: {
  transports: { console: Record<string, unknown> };
}): void {
  const consoleTransport = log.transports.console as {
    level: string;
    format: unknown;
  };

  consoleTransport.level = "info";

  consoleTransport.format = ({ message }: { message: { date: Date; level: string; data: unknown[]; variables?: Record<string, string> } }) => {
    const [head, ...rest] = message.data;

    let source: string = message.variables?.processType ?? "main";
    let correlationId: string | undefined;
    let msgParts: unknown[];

    if (
      head !== null &&
      typeof head === "object" &&
      (head as Record<string, unknown>).__nx_log === true
    ) {
      const env = head as NxLogMeta;
      source = env.source;
      correlationId = env.correlationId;
      msgParts = rest;
    } else {
      msgParts = [head, ...rest];
    }

    const prefix = correlationId ? `[${source}] [${correlationId}]` : `[${source}]`;

    return [
      message.date.toISOString().slice(11, 23),
      message.level.toUpperCase(),
      prefix,
      ...msgParts,
    ];
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure electron-log transports and wire the renderer IPC relay.
 * Must be called once in the main process before any BrowserWindow opens.
 * Loads electron and electron-log/main lazily to avoid test-environment
 * side effects when this module is merely imported.
 */
export function initMainLogger(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const log = (require("electron-log/main") as { default: unknown }).default as {
    transports: { file: Record<string, unknown>; console: Record<string, unknown> };
    initialize(): void;
  };

  const logsDir = app.getPath("logs");
  configureFileTransport(log, logsDir);
  configureConsoleTransport(log);

  // Injects the built-in electron-log preload script into all sessions so
  // the renderer can send log messages over IPC without a custom channel.
  log.initialize();
}

/**
 * Returns a Logger whose every call tags the record with the given source.
 * Accepts any string so that the Go-agent forwarding path (T6) can pass
 * arbitrary source labels like `"agent"`.
 *
 * Loads electron-log/main lazily; falls back to console when the Electron
 * context is unavailable (e.g. the bun test runner without an app mock).
 */
/** Minimal log sink shape required by the facade. */
type LogSink = {
  error: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
};

export function createLogger(source: LogSource | string): Logger {
  let cached: LogSink | null = null;

  function getLog(): LogSink {
    if (cached !== null) return cached;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = (require("electron-log/main") as { default: unknown }).default;
      cached = loaded as LogSink;
    } catch {
      // Non-Electron environment: fall back to console so tests and scripts
      // that import this module without a live app do not crash.
      cached = {
        error: (...a: unknown[]) => console.error(...a),
        warn: (...a: unknown[]) => console.warn(...a),
        info: (...a: unknown[]) => console.info(...a),
        debug: (...a: unknown[]) => console.debug(...a),
      };
    }
    return cached;
  }

  return {
    error(msg: string, meta?: LogMeta): void {
      getLog().error(buildMeta(source, meta), msg);
    },
    warn(msg: string, meta?: LogMeta): void {
      getLog().warn(buildMeta(source, meta), msg);
    },
    info(msg: string, meta?: LogMeta): void {
      getLog().info(buildMeta(source, meta), msg);
    },
    debug(msg: string, meta?: LogMeta): void {
      getLog().debug(buildMeta(source, meta), msg);
    },
  };
}

