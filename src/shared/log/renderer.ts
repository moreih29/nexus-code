import type { Logger, LogMeta, LogSource, NxLogMeta } from "./types";

function buildMeta(source: LogSource | string, meta?: LogMeta): NxLogMeta {
  return {
    __nx_log: true,
    source,
    ...(meta?.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  };
}

function hasWindowMessaging(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function";
}

type LogSink = {
  error: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
};

function electronLogBridge(): LogSink | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { __electronLog?: Partial<LogSink> }).__electronLog;
  if (!bridge) return null;
  const { error, warn, info, debug } = bridge;
  if ([error, warn, info, debug].some((fn) => typeof fn !== "function")) return null;
  return bridge as LogSink;
}

export function createLogger(source: LogSource | string): Logger {
  let cached: LogSink | null = null;

  function getLog(): LogSink {
    if (cached !== null) return cached;

    const bridge = electronLogBridge();
    if (bridge !== null) {
      cached = bridge;
      return cached;
    }

    if (!hasWindowMessaging()) {
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
