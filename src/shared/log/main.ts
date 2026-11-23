import type { Logger, LogMeta, LogSource, NxLogMeta } from "./types";

export const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;

function buildMeta(source: LogSource | string, meta?: LogMeta): NxLogMeta {
  return {
    __nx_log: true,
    source,
    ...(meta?.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  };
}

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
    maxSize: number;
  };

  fileTransport.maxSize = LOG_FILE_MAX_BYTES;
  fileTransport.resolvePathFn = () => nodePath.join(logsDir, "main.log");
  fileTransport.level = "debug";

  fileTransport.format = ({
    message,
  }: {
    message: { date: Date; level: string; data: unknown[]; variables?: Record<string, string> };
  }) => {
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

function configureConsoleTransport(log: {
  transports: { console: Record<string, unknown> };
}): void {
  const consoleTransport = log.transports.console as {
    level: string | false;
    format: unknown;
  };

  consoleTransport.level = "info";

  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {
      consoleTransport.level = false;
    });
  }

  consoleTransport.format = ({
    message,
  }: {
    message: { date: Date; level: string; data: unknown[]; variables?: Record<string, string> };
  }) => {
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

export function initMainLogger(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app, session } = require("electron") as typeof import("electron");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const log = (require("electron-log/main") as { default: unknown }).default as {
    transports: { file: Record<string, unknown>; console: Record<string, unknown> };
    initialize(options: {
      getSessions: () => unknown[];
      includeFutureSession: boolean;
      includeFutureSessions: boolean;
    }): void;
  };

  const logsDir = app.getPath("logs");
  configureFileTransport(log, logsDir);
  configureConsoleTransport(log);

  log.initialize({
    getSessions: () => [session.defaultSession],
    includeFutureSession: false,
    includeFutureSessions: false,
  });
}

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
