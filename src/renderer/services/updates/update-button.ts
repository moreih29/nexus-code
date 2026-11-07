/**
 * What the title bar's update button shows, if anything: a newer version
 * the user did not skip, then the download, its check and the restart that
 * installs it, or the install that failed. Nothing otherwise. Pure.
 */

import type { UpdateProgress, UpdateStatus } from "../../../shared/updates/status";

export type UpdateButton =
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent?: number }
  | { readonly kind: "verifying"; readonly version: string }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "failed" };

export function updateButtonOf(
  status: UpdateStatus | null,
  progress: UpdateProgress | null,
  ignoredVersion: string | null,
): UpdateButton | null {
  switch (status?.kind) {
    case "newer":
      return status.latest === ignoredVersion
        ? null
        : { kind: "available", version: status.latest };
    case "downloading": {
      const known = progress !== null && progress.version === status.version && progress.total > 0;
      return known
        ? {
            kind: "downloading",
            version: status.version,
            percent: Math.min(100, Math.round((progress.transferred / progress.total) * 100)),
          }
        : { kind: "downloading", version: status.version };
    }
    case "verifying":
      return { kind: "verifying", version: status.version };
    case "ready":
      return { kind: "ready", version: status.version };
    case "installFailed":
      return { kind: "failed" };
    default:
      return null;
  }
}
