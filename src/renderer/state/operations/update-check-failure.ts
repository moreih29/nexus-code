/**
 * User-facing text for a failed update check, worded from the failure reason
 * main reports (the raw detail stays in the main-process log).
 */

import i18next from "i18next";

export interface UpdateCheckFailure {
  reason: "rate-limited" | "http" | "network" | "unexpected";
  status?: number;
}

export function updateCheckFailedMessage(failure: UpdateCheckFailure): string {
  switch (failure.reason) {
    case "rate-limited":
      return i18next.t("common:updates.failedRateLimited");
    case "http":
      return failure.status === undefined
        ? i18next.t("common:updates.failed")
        : i18next.t("common:updates.failedHttp", { status: failure.status });
    case "network":
      return i18next.t("common:updates.failedNetwork");
    case "unexpected":
      return i18next.t("common:updates.failed");
  }
}
