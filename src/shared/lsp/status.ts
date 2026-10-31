/**
 * What main knows of each language server, for the status bar, its menu and
 * the log viewer.
 */

import { z } from "zod";

/**
 * Why a server is not running:
 * - idle: the agent stopped it after LSP_DEFAULT_IDLE_MS unused.
 * - evicted: the workspace cap stopped it for another workspace's.
 * - off: a setting turned it off.
 * - restart: stopped to start again, by the user or a setting.
 * - agent: the workspace's agent exited or was replaced.
 * - crashed: it exited on its own, or stopped answering; it starts again
 *   unless it did so LSP_CRASH_LIMIT times within LSP_CRASH_WINDOW_MS.
 */
export const LspStopReasonSchema = z.enum([
  "idle",
  "evicted",
  "off",
  "restart",
  "agent",
  "crashed",
]);
export type LspStopReason = z.infer<typeof LspStopReasonSchema>;

export const LspServerStatusSchema = z.object({
  workspaceId: z.string(),
  /** The preset language id: "typescript" covers JavaScript too. */
  languageId: z.string(),
  state: z.enum(["starting", "running", "stopped", "failed"]),
  stopReason: LspStopReasonSchema.optional(),
  /** failed: what went wrong, for the user. */
  error: z.string().optional(),
  /**
   * failed: the server failed too often in a row and starts again only when
   * the user restarts it or changes its settings.
   */
  gaveUp: z.boolean().optional(),
  /** failed: the server is not installed on the workspace's host. */
  missingBinary: z.string().optional(),
  /** The name and version the server gave in its initialize result. */
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;

export const LspLogLevelSchema = z.enum(["error", "warning", "info", "log", "stderr", "lifecycle"]);
export type LspLogLevel = z.infer<typeof LspLogLevelSchema>;

export const LspLogEntrySchema = z.object({
  /** Increasing per server, so a viewer can ask for what came after. */
  seq: z.number().int(),
  time: z.number(),
  level: LspLogLevelSchema,
  message: z.string(),
});
export type LspLogEntry = z.infer<typeof LspLogEntrySchema>;

export const LspServerMemorySchema = z.object({
  languageId: z.string(),
  /** Resident memory of the server and the processes it started. */
  rssBytes: z.number(),
});
export type LspServerMemory = z.infer<typeof LspServerMemorySchema>;
