import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LimitResume } from "../../../shared/types/layout";
import { type BannerScope, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { resumeTimeText } from "../../services/chat/limit-resume";
import { cancelLimitResume, resumeLimitNow } from "../../services/chat/limit-resume-scheduler";
import { Banner, type BannerAction } from "../ui/banner";

export interface LimitResumeShown {
  state: string;
  stopAt?: number;
  at?: number;
  resetsAt?: number;
  tries?: number;
}

const SHOWN = new Set(["waiting", "unknown", "cancelled", "gave_up"]);

export function showsLimitResume<T extends LimitResumeShown>(record: T | undefined): record is T {
  return record !== undefined && SHOWN.has(record.state);
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
  return (
    <LimitResumeView
      scope={["chat", workspaceId, tabId, record.session]}
      record={record}
      actions={actions}
    />
  );
}

export function LimitResumeView({
  scope,
  record,
  actions,
}: {
  scope: BannerScope;
  record: LimitResumeShown | undefined;
  actions?: BannerAction[];
}) {
  const { t, i18n } = useTranslation();
  const { dismiss, dismissed } = useBannerDismissal(
    [...scope, "limit-resume", record?.stopAt !== undefined],
    record && [record.stopAt, record.state, record.at, record.resetsAt, record.tries],
    record?.stopAt === undefined,
  );
  if (!showsLimitResume(record) || dismissed) return null;
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
        dismiss={dismiss}
        {...(actions ? { actions } : {})}
      />
    </div>
  );
}
