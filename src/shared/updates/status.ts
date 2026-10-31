import { z } from "zod";

const TriggerSchema = z.enum(["auto", "manual"]);

/**
 * Where an app update stands: the result of a check (`checking`, `newer`,
 * `current`, `error`) or a step of an in-place update (`downloading` →
 * `verifying` → `ready`, or `installFailed`).
 *
 * "checking" is only broadcast for trigger="manual" (with a 3-second delay).
 * "current" and "error" from an auto check are not broadcast; the renderer
 * reads them with `updates.getStatus`.
 */
export const UpdateStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checking"), trigger: TriggerSchema }),
  z.object({
    kind: z.literal("newer"),
    trigger: TriggerSchema,
    current: z.string(),
    latest: z.string(),
    releaseUrl: z.string(),
    /** Whether `install` can update this app in place. */
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
    // The renderer words the message from the reason; the detail stays in
    // the main-process log.
    reason: z.enum(["rate-limited", "http", "network", "unexpected"]),
    status: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("downloading"), version: z.string() }),
  // The download is done and the updater checks it (Squirrel.Mac's signature
  // check); only macOS has this step.
  z.object({ kind: z.literal("verifying"), version: z.string() }),
  z.object({
    kind: z.literal("ready"),
    version: z.string(),
    // Installing asks for the admin password (a deb).
    asksForPassword: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal("installFailed"), releaseUrl: z.string() }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/** How far the download of `version` has got, in bytes of what it fetches. */
export const UpdateProgressSchema = z.object({
  version: z.string(),
  transferred: z.number().nonnegative(),
  total: z.number().nonnegative(),
  bytesPerSecond: z.number().nonnegative(),
});
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

function isUnderWay(status: UpdateStatus | null): boolean {
  return status?.kind === "downloading" || status?.kind === "verifying" || status?.kind === "ready";
}

function isInstallStep(status: UpdateStatus): boolean {
  return isUnderWay(status) || status.kind === "installFailed";
}

/**
 * The status to show after `next` arrives: the latest one, except that a
 * check does not hide an update that is under way.
 */
export function nextUpdateStatus(
  current: UpdateStatus | null,
  next: UpdateStatus,
): UpdateStatus | null {
  return isUnderWay(current) && !isInstallStep(next) ? current : next;
}
