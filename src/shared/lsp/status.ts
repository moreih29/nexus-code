import { z } from "zod";
import { IntegerSchema, NumberSchema } from "../../../packages/remote-protocol/src/validation";

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
  languageId: z.string(),
  state: z.enum(["starting", "running", "stopped", "failed"]),
  stopReason: LspStopReasonSchema.optional(),
  error: z.string().optional(),
  gaveUp: z.boolean().optional(),
  missingBinary: z.string().optional(),
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;

export const LspLogLevelSchema = z.enum(["error", "warning", "info", "log", "stderr", "lifecycle"]);
export type LspLogLevel = z.infer<typeof LspLogLevelSchema>;

export const LspLogEntrySchema = z.object({
  seq: IntegerSchema,
  time: NumberSchema,
  level: LspLogLevelSchema,
  message: z.string(),
});
export type LspLogEntry = z.infer<typeof LspLogEntrySchema>;

export const LspServerMemorySchema = z.object({
  languageId: z.string(),
  rssBytes: NumberSchema,
});
export type LspServerMemory = z.infer<typeof LspServerMemorySchema>;
