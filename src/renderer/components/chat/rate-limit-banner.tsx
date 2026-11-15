// Over the composer when the plan's limit is near (a warning, which closes
// until the limit resets) or reached (which stays up).

import { useTranslation } from "react-i18next";
import type { RateLimitInfo } from "../../services/chat/model";
import { rateLimitKey, rateLimitNotice } from "../../services/chat/rate-limit";
import { shownReset } from "../../services/chat/usage-line";
import { useNotificationsStore } from "../../state/stores/notifications";
import { Banner } from "../ui/banner";

export function RateLimitBanner({ limit }: { limit: RateLimitInfo | undefined }) {
  const { t } = useTranslation();
  const warnings = useNotificationsStore((s) => s.rateLimitWarnings);
  const dismissed = useNotificationsStore((s) => s.dismissedRateLimits);
  const notice = rateLimitNotice(limit, { warnings, dismissed });
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
  // A warning closes until its limit resets; a limit reached stays up.
  const dismiss = rejected
    ? undefined
    : {
        label: t("chat.rate_limit.dismiss"),
        onDismiss: () => useNotificationsStore.getState().dismissRateLimit(rateLimitKey(limit)),
      };
  return (
    <div className="shrink-0" data-testid="chat-rate-limit">
      <Banner variant={rejected ? "error" : "warning"} message={message} dismiss={dismiss} />
    </div>
  );
}
