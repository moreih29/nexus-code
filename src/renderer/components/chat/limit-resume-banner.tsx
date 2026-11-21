// Over the composer of a tab the plan's usage limit stopped: when the app
// goes on by itself (with [Cancel] and [Go on now]), or why it does not.
// In a Claude tab it takes the place of the limit-reached banner.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LimitResume } from "../../../shared/types/layout";
import { resumeTimeText } from "../../services/chat/limit-resume";
import { cancelLimitResume, resumeLimitNow } from "../../services/chat/limit-resume-scheduler";
import { Banner, type BannerAction } from "../ui/banner";

/** Whether the tab shows this banner: a record, but not while the app's message runs. */
export function showsLimitResume(record: LimitResume | undefined): record is LimitResume {
  return record !== undefined && record.state !== "sent";
}

export function LimitResumeBanner({
  workspaceId,
  tabId,
  record,
}: {
  workspaceId: string;
  tabId: string;
  record: LimitResume | undefined;
}) {
  const { t, i18n } = useTranslation();
  const [sending, setSending] = useState(false);
  if (!showsLimitResume(record)) return null;
  const time = (at: number | undefined) =>
    at === undefined ? "" : resumeTimeText(at, Date.now(), i18n.language);
  const goOn: BannerAction = {
    label: t("chat.limit_resume.now"),
    onAction: () => {
      if (sending) return;
      setSending(true);
      void resumeLimitNow(workspaceId, tabId).finally(() => setSending(false));
    },
  };
  const message =
    record.state === "waiting"
      ? t("chat.limit_resume.waiting", { time: time(record.at) })
      : record.state === "cancelled" && record.resetsAt !== undefined
        ? t("chat.limit_resume.cancelled", { time: time(record.resetsAt) })
        : record.state === "gave_up"
          ? t("chat.limit_resume.gave_up", { tries: record.tries })
          : t("chat.limit_resume.unknown");
  const actions: BannerAction[] =
    record.state === "waiting"
      ? [
          {
            label: t("chat.limit_resume.cancel"),
            variant: "ghost",
            onAction: () => cancelLimitResume(workspaceId, tabId),
          },
          goOn,
        ]
      : [goOn];
  return (
    <div className="shrink-0" data-testid="chat-limit-resume">
      <Banner
        variant={record.state === "waiting" ? "info" : "warning"}
        message={message}
        actions={actions}
      />
    </div>
  );
}
