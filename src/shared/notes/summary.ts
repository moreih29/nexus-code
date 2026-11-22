import { z } from "zod";
import { redactLogSecrets } from "../log/redact-secrets";
import { RECORDING_ID_RE } from "./transcript";

export const RecordingSummarySettingsSchema = z.object({
  enabled: z.boolean(),
  agent: z.literal("claude"),
  profileId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(256).optional(),
});
export type RecordingSummarySettings = z.infer<typeof RecordingSummarySettingsSchema>;
export const DEFAULT_RECORDING_SUMMARY_SETTINGS: RecordingSummarySettings = {
  enabled: false,
  agent: "claude",
};

export const RecordingIdSchema = z.string().regex(RECORDING_ID_RE);
export const SummaryModeSchema = z.enum(["auto", "retry", "rerun"]);
export type SummaryMode = z.infer<typeof SummaryModeSchema>;

/** Redact the full diagnostic before taking its UTF-8 tail. */
export function summaryDiagnostic(text: string): string | undefined {
  const redacted = redactLogSecrets(text).replace(/\bsk-[a-z0-9_-]+/gi, "[redacted]");
  const bytes = new TextEncoder().encode(redacted);
  let start = Math.max(0, bytes.length - 1024);
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start)).trim() || undefined;
}

export const SummaryErrorSchema = z.object({
  kind: z.enum(["signed-out", "missing", "limit", "timeout", "interrupted", "too-long", "failed"]),
  message: z.string().transform(summaryDiagnostic).optional(),
  resetsAt: z.number().nonnegative().optional(),
});
export type SummaryError = z.infer<typeof SummaryErrorSchema>;

const summaryRun = RecordingSummarySettingsSchema.pick({
  agent: true,
  profileId: true,
  model: true,
}).extend({
  runId: z.uuid(),
  startedAt: z.number().nonnegative(),
  seen: z.boolean(),
});
const finished = summaryRun.extend({ endedAt: z.number().nonnegative() });

export const RecordingSummarySchema = z.discriminatedUnion("state", [
  summaryRun.extend({ state: z.literal("running") }),
  finished.extend({ state: z.literal("done"), todos: z.number().int().nonnegative().max(15) }),
  finished.extend({ state: z.literal("failed"), error: SummaryErrorSchema }),
  finished.extend({ state: z.literal("skipped") }),
  finished.extend({ state: z.literal("undone") }),
]);
export type RecordingSummary = z.infer<typeof RecordingSummarySchema>;
export type RunningSummary = Extract<RecordingSummary, { state: "running" }>;
export const RecordingSummariesSchema = z.record(RecordingIdSchema, RecordingSummarySchema);

export function failedSummary(run: RunningSummary, error: SummaryError): RecordingSummary {
  return { ...run, state: "failed", endedAt: Date.now(), error };
}

export function summaryOrigin(recordingId: string): string {
  return `summary:${recordingId}`;
}
