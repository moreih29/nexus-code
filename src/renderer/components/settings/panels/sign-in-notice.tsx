// src/renderer/components/settings/panels/sign-in-notice.tsx
//
// Why the last sign-in did not finish, as a notice: what happened, the line
// saying the server takes approved accounts only when that is why, what to
// do, and its buttons. Settings › Remote shows it whole; the Other computers
// list, narrow, shows the title and one line under it. The browser's page
// after the sign-in (main's loopback) says the same words.

import { CircleAlert, Clock, Info } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  APPROVED_ONLY_FAILURES,
  type SignInFailure,
  type SignInFailureTone,
  type SignInProvider,
  signInFailureTone,
  signInProviderName,
} from "../../../../shared/remote/account";
import { bannerColorClass } from "../../ui/banner";

/** A failure the notice tells; a sign-in the user cancelled in the app goes unsaid. */
export type ShownSignInFailure = Exclude<SignInFailure, "cancelled">;

// The error tone tints the whole box (and so its icon); the others say theirs by the icon.
const ICON_TONE: Record<SignInFailureTone, string> = {
  info: "text-[var(--state-info-fg)]",
  warning: "text-[var(--state-warning-fg)]",
  error: "",
};

export function SignInNotice({
  failure,
  provider,
  compact = false,
  actions,
  dismiss,
}: {
  failure: ShownSignInFailure;
  /** The sign-in a pending approval is for: its body names it, to sign in again with. */
  provider?: SignInProvider;
  /** The narrow list's: the title and one line, the approved-only line when there is one. */
  compact?: boolean;
  actions?: ReactNode;
  dismiss?: ReactNode;
}) {
  const { t } = useTranslation("settings");
  const tone = signInFailureTone(failure);
  const approvedOnly = APPROVED_ONLY_FAILURES.includes(failure);
  const Icon = failure === "pending_approval" ? Clock : tone === "info" ? Info : CircleAlert;
  const providerName = failure === "pending_approval" ? signInProviderName(provider) : undefined;
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      data-testid="sign-in-notice"
      data-failure={failure}
      className={cn(
        "flex items-start rounded-(--radius-raised) border",
        compact ? "gap-1.5 px-2 py-1.5" : "gap-2.5 px-3 py-2.5",
        bannerColorClass(tone === "error" ? "error" : "info"),
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 shrink-0", compact ? "size-3.5" : "size-4", ICON_TONE[tone])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 break-keep">
        <p
          className={cn(
            "font-medium text-foreground",
            compact ? "text-app-ui-sm" : "text-app-body",
          )}
        >
          {t(`remote.account.failure.${failure}.title`)}
        </p>
        {approvedOnly && (
          <p className="text-app-ui-sm text-foreground">{t("remote.account.approvedOnly")}</p>
        )}
        {!(compact && approvedOnly) && (
          <p className="text-app-ui-sm text-muted-foreground">
            {providerName
              ? t("remote.account.failure.pending_approval.bodyWithProvider", {
                  provider: providerName,
                })
              : t(`remote.account.failure.${failure}.body`)}
          </p>
        )}
        {actions && (
          <div className={cn("flex flex-wrap items-center gap-2", compact ? "mt-0.5" : "mt-2")}>
            {actions}
          </div>
        )}
      </div>
      {dismiss}
    </div>
  );
}
