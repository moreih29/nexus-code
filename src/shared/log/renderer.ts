/**
 * Renderer-process logging facade built on electron-log v5.
 *
 * Log calls are forwarded over IPC to the main process where they are
 * written by the configured transports.  The preload wiring in
 * `src/preload/index.ts` is required for this relay to work under
 * contextIsolation.
 *
 * electron-log/renderer is loaded lazily (inside function bodies) so that
 * merely importing this module does not call `window.addEventListener`, which
 * crashes the bun test runner when `window` is not a full DOM object.
 * When the IPC relay is unavailable (no real `window.addEventListener`), the
 * factory returns a console-based fallback Logger so callers do not crash.
 */

import type { Logger, LogMeta, LogSource, NxLogMeta } from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the structured envelope so the main-process file-transport format
 * can extract `source` and `correlationId` from the IPC-relayed message.
 */
function buildMeta(source: LogSource | string, meta?: LogMeta): NxLogMeta {
  return {
    __nx_log: true,
    source,
    ...(meta?.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  };
}

/**
 * Returns true when the current environment has a functional
 * `window.addEventListener`, which electron-log/renderer requires at load
 * time to set up its IPC message listener.
 */
function hasWindowMessaging(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a Logger bound to the given source tag.  All calls are forwarded
 * over IPC to the main-process transports, which write to the shared log
 * file.
 *
 * When `window.addEventListener` is unavailable (test runner, SSR context,
 * or any non-browser environment), a console-based fallback is returned so
 * the calling module does not crash on import.
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

    if (!hasWindowMessaging()) {
      // Non-Electron renderer environment: fall back to console so tests and
      // scripts that import this module without a live window do not crash.
      cached = {
        error: (...a: unknown[]) => console.error(...a),
        warn: (...a: unknown[]) => console.warn(...a),
        info: (...a: unknown[]) => console.info(...a),
        debug: (...a: unknown[]) => console.debug(...a),
      };
      return cached;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = (require("electron-log/renderer") as { default: unknown }).default;
      cached = loaded as LogSink;
    } catch {
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
