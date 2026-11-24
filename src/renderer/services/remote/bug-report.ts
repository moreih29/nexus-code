import i18next from "i18next";
import type {
  BugReportDraft,
  BugReportFailure,
  BugReportOutcome,
} from "../../../shared/remote/bug-report";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult } from "../../ipc/client";

const HOUR = 3600;

export function bugReportFailureMessage(failure: BugReportFailure, retryAfter?: number): string {
  const t = i18next.t.bind(i18next);
  switch (failure) {
    case "rate-limited":
      if (retryAfter === undefined || retryAfter <= 0)
        return t("settings:about.bugReport.error.rateLimited");
      return retryAfter < HOUR
        ? t("settings:about.bugReport.error.rateLimitedMinutes", {
            count: Math.max(1, Math.ceil(retryAfter / 60)),
          })
        : t("settings:about.bugReport.error.rateLimitedHours", {
            count: Math.ceil(retryAfter / HOUR),
          });
    case "signed-out":
      return t("settings:about.bugReport.error.signedOut");
    case "not-allowed":
      return t("settings:about.bugReport.error.notAllowed");
    case "too-big":
      return t("settings:about.bugReport.error.tooBig");
    case "unsupported":
      return t("settings:about.bugReport.error.unsupported");
    case "offline":
      return t("settings:about.bugReport.error.offline");
    case "failed":
      return t("settings:about.bugReport.error.failed");
  }
}

function failedOutcome(): BugReportOutcome {
  return { status: "failed", failure: "failed" };
}

export async function sendBugReport(draft: BugReportDraft): Promise<boolean> {
  const result = await ipcCallResult("remote", "sendBugReport", draft).catch(() => null);
  const outcome = result?.ok ? result.value : failedOutcome();
  if (outcome.status === "sent") {
    showToast({ kind: "info", message: i18next.t("settings:about.bugReport.sent") });
    return true;
  }
  showToast({
    kind: "error",
    message: bugReportFailureMessage(outcome.failure, outcome.retryAfter),
  });
  return false;
}
