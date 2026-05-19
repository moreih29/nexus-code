/**
 * Shared type definitions for the application logging facade.
 *
 * All log entries carry a `source` tag that identifies which process or
 * subsystem emitted the record, and an optional `correlationId` to link
 * related log lines across process boundaries.
 */

/** Which process or subsystem produced a log entry. */
export type LogSource = "main" | "renderer" | "agent";

/** Supported log levels, from most to least severe. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** Optional per-call metadata attached to every log entry. */
export interface LogMeta {
  /** Cross-process correlation token — forwarded as-is to the file sink. */
  correlationId?: string;
}

/**
 * The narrow facade API exposed to every callsite.  The source is bound
 * when the logger is created so callers never have to repeat it.
 */
export interface Logger {
  error(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  debug(msg: string, meta?: LogMeta): void;
}

/**
 * Internal envelope prepended to electron-log's `data` array so that the
 * file-transport transform can extract structured fields without touching
 * the free-form message text.
 *
 * The sentinel key `__nx_log` is intentionally unlikely to collide with
 * application data.
 */
export interface NxLogMeta {
  __nx_log: true;
  source: LogSource | string;
  correlationId?: string;
}
