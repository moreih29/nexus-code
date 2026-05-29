/**
 * Pure view model for push guardrail banners.
 */
import i18next from "i18next";

export interface PushGuardPushOptions {
  readonly force?: boolean;
  readonly publish?: boolean;
}

export interface PushGuardPendingRetry {
  readonly branch: string;
  readonly attemptedAt: number;
  readonly originalPushOpts: PushGuardPushOptions;
}

export type PushGuardActionKind = "pull" | "force" | "cancel" | "retry" | "fetch";

export interface PushGuardBannerAction {
  readonly kind: PushGuardActionKind;
  readonly label: string;
  readonly destructive?: boolean;
}

export interface PushGuardBannerView {
  readonly variant: "warning" | "success" | "error";
  readonly message: string;
  readonly details?: string;
  readonly actions: PushGuardBannerAction[];
}

interface PushGuardError {
  readonly kind: string;
  readonly message: string;
  readonly details?: string;
}

interface PushGuardBannerInput {
  readonly error: PushGuardError | null | undefined;
  readonly pendingNonFFRetry: PushGuardPendingRetry | null | undefined;
  readonly inFlightKind: string | null | undefined;
}

/**
 * Converts typed push failures plus pending retry state into banner copy.
 * The action callbacks stay in GitPanel so this module remains testable.
 */
export function buildPushGuardBannerView({
  error,
  pendingNonFFRetry,
  inFlightKind,
}: PushGuardBannerInput): PushGuardBannerView | null {
  const t = i18next.t.bind(i18next);
  if (error?.kind === "non-fast-forward") {
    return {
      variant: "warning",
      message: t("files:git.pushGuard.nonFastForward"),
      details: error.details,
      actions: [
        { kind: "pull", label: t("files:git.pushGuard.pull") },
        { kind: "force", label: t("files:git.pushGuard.force"), destructive: true },
        { kind: "cancel", label: t("files:git.pushGuard.cancel") },
      ],
    };
  }

  if (error?.kind === "force-push-rejected") {
    return {
      variant: "warning",
      message: t("files:git.pushGuard.forcePushRejected"),
      details: error.details,
      actions: [{ kind: "fetch", label: t("files:git.pushGuard.fetch") }],
    };
  }

  if (error?.kind === "protected-branch" || error?.kind === "pre-receive-hook-rejected") {
    return {
      variant: "error",
      message: error.details ?? error.message,
      actions: [],
    };
  }

  if (pendingNonFFRetry && !error && !inFlightKind) {
    return {
      variant: "success",
      message: t("files:git.pushGuard.pulledRetry"),
      actions: [{ kind: "retry", label: t("files:git.pushGuard.retry") }],
    };
  }

  return null;
}
