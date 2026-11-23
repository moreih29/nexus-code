import { z } from "zod";
import {
  IntegerSchema,
  NonnegativeNumberSchema,
} from "../../../packages/remote-protocol/src/validation";

const TriggerSchema = z.enum(["auto", "manual"]);

export const UpdateStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checking"), trigger: TriggerSchema }),
  z.object({
    kind: z.literal("newer"),
    trigger: TriggerSchema,
    current: z.string(),
    latest: z.string(),
    releaseUrl: z.string(),
    canInstall: z.boolean(),
  }),
  z.object({
    kind: z.literal("current"),
    trigger: TriggerSchema,
    current: z.string(),
    latest: z.string().optional(),
  }),
  z.object({
    kind: z.literal("error"),
    trigger: TriggerSchema,
    reason: z.enum(["rate-limited", "http", "network", "unexpected", "response-too-large"]),
    status: IntegerSchema.optional(),
  }),
  z.object({ kind: z.literal("downloading"), version: z.string() }),
  z.object({ kind: z.literal("verifying"), version: z.string() }),
  z.object({
    kind: z.literal("ready"),
    version: z.string(),
    asksForPassword: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal("installFailed"), releaseUrl: z.string() }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateProgressSchema = z.object({
  version: z.string(),
  transferred: NonnegativeNumberSchema,
  total: NonnegativeNumberSchema,
  bytesPerSecond: NonnegativeNumberSchema,
});
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

function isUnderWay(status: UpdateStatus | null): boolean {
  return status?.kind === "downloading" || status?.kind === "verifying" || status?.kind === "ready";
}

function isInstallStep(status: UpdateStatus): boolean {
  return isUnderWay(status) || status.kind === "installFailed";
}

export function nextUpdateStatus(
  current: UpdateStatus | null,
  next: UpdateStatus,
): UpdateStatus | null {
  return isUnderWay(current) && !isInstallStep(next) ? current : next;
}
