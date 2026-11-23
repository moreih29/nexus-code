export type LogSource = "main" | "renderer" | "agent";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogMeta {
  correlationId?: string;
}

export interface Logger {
  error(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  debug(msg: string, meta?: LogMeta): void;
}

export interface NxLogMeta {
  __nx_log: true;
  source: LogSource | string;
  correlationId?: string;
}
