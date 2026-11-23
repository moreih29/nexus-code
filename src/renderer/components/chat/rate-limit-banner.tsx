import { useTranslation } from "react-i18next";
import type { BannerScope } from "../../hooks/use-banner-dismissal";
import { rateLimitKey, rateLimitNotice } from "../../services/chat/claude/rate-limit";
import type { RateLimitInfo } from "../../services/chat/model";
import { shownReset } from "../../services/chat/usage-line";
import { useNotificationsStore } from "../../state/stores/notifications";
import { Banner } from "../ui/banner";

export function RateLimitBanner({
  limit,
  scope,
}: {
  limit: RateLimitInfo | undefined;
  scope: BannerScope;
}) {
  const { t } = useTranslation();
  const warnings = useNotificationsStore((s) => s.rateLimitWarnings);
  const dismissed = useNotificationsStore((s) => s.dismissedRateLimits);
  const notice = rateLimitNotice(limit, { warnings, dismissed, scope });
  if (!limit || !notice) return null;
  const resets = limit.resetsAt
    ? shownReset(limit.resetsAt * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const rejected = notice === "rejected";
  const message = rejected
    ? resets
      ? t("chat.rate_limit.rejected_until", { time: resets })
      : t("chat.rate_limit.rejected")
    : resets
      ? t("chat.rate_limit.warning_until", { time: resets })
      : t("chat.rate_limit.warning");
  const dismiss = {
    label: t(rejected ? "action.dismiss" : "chat.rate_limit.dismiss"),
    onDismiss: () => useNotificationsStore.getState().dismissRateLimit(rateLimitKey(limit, scope)),
  };
  return (
    <div className="shrink-0" data-testid="chat-rate-limit">
      <Banner variant={rejected ? "error" : "warning"} message={message} dismiss={dismiss} />
    </div>
  );
}
