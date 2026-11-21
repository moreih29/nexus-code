// Over the composer of a tab the plan's usage limit stopped: when the app
// goes on by itself (with [Cancel] and [Resume now]), or why it does not.
// In a Claude tab it takes the place of the limit-reached banner. Another
// device's chat shows the same, without the buttons: they are its app's.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LimitResume } from "../../../shared/types/layout";
import { resumeTimeText } from "../../services/chat/limit-resume";
import { cancelLimitResume, resumeLimitNow } from "../../services/chat/limit-resume-scheduler";
import { Banner, type BannerAction } from "../ui/banner";

/** Going on after the usage limit as a banner tells it: a tab's own, or another device's. */
export interface LimitResumeShown {
  state: string;
  at?: number;
  resetsAt?: number;
  tries?: number;
}

const SHOWN = new Set(["waiting", "unknown", "cancelled", "gave_up"]);

/** Whether a banner shows for it: not while the app's message runs, nor a state not known here. */
export function showsLimitResume<T extends LimitResumeShown>(record: T | undefined): record is T {
  return record !== undefined && SHOWN.has(record.state);
}

/** A tab's own banner, with [Cancel] while it waits and [Resume now]. */
export function LimitResumeBanner({
  workspaceId,
  tabId,
  record,
}: {
  workspaceId: string;
  tabId: string;
  record: LimitResume | undefined;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  if (!showsLimitResume(record)) return null;
  const goOn: BannerAction = {
    label: t("chat.limit_resume.now"),
    onAction: () => {
      if (sending) return;
      setSending(true);
      void resumeLimitNow(workspaceId, tabId).finally(() => setSending(false));
    },
  };
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
  return <LimitResumeView record={record} actions={actions} />;
}

/** The banner itself; with no actions, as another device's chat shows it. */
export function LimitResumeView({
  record,
  actions,
}: {
  record: LimitResumeShown | undefined;
  actions?: BannerAction[];
}) {
  const { t, i18n } = useTranslation();
  if (!showsLimitResume(record)) return null;
  const time = (at: number | undefined) =>
    at === undefined ? "" : resumeTimeText(at, Date.now(), i18n.language);
  const message =
    record.state === "waiting" && record.at !== undefined
      ? t("chat.limit_resume.waiting", { time: time(record.at) })
      : record.state === "cancelled" && record.resetsAt !== undefined
        ? t("chat.limit_resume.cancelled", { time: time(record.resetsAt) })
        : record.state === "gave_up"
          ? t("chat.limit_resume.gave_up", { tries: record.tries ?? 0 })
          : t("chat.limit_resume.unknown");
  return (
    <div className="shrink-0" data-testid="chat-limit-resume">
      <Banner
        variant={record.state === "waiting" ? "info" : "warning"}
        message={message}
        {...(actions ? { actions } : {})}
      />
    </div>
  );
}
