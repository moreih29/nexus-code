/**
 * Pure view model for push guardrail banners.
 */

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
  if (error?.kind === "non-fast-forward") {
    return {
      variant: "warning",
      message: "Remote has commits you don't have. Pull first?",
      details: error.details,
      actions: [
        { kind: "pull", label: "Pull" },
        { kind: "force", label: "Force", destructive: true },
        { kind: "cancel", label: "Cancel" },
      ],
    };
  }

  if (error?.kind === "force-push-rejected") {
    return {
      variant: "warning",
      message: "Force push rejected (lease check failed) — Fetch first?",
      details: error.details,
      actions: [{ kind: "fetch", label: "Fetch" }],
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
      message: "Pulled. Retry push?",
      actions: [{ kind: "retry", label: "Retry" }],
    };
  }

  return null;
}
