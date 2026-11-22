/**
 * GitInlineBanner — thin shim over the generic Banner primitive.
 *
 * Intentionally kept separate (not collapsed to direct Banner calls) because
 * it resolves the actionLabel/onAction → actions[] impedance mismatch for the
 * many git-panel call sites that use the single-action shorthand. Eliminating
 * the shim would require spreading actions arrays across git-banner-stack.tsx,
 * git-banner-model.ts, and history/panel.tsx — more churn than the shim
 * justifies. (T7 consistency review, 2026-05.)
 */
import {
  Banner,
  type BannerAction,
  type BannerDismiss,
  type BannerVariant,
} from "../../../ui/banner";

export type GitInlineBannerVariant = BannerVariant;
export type GitInlineBannerActionVariant = "default" | "destructive" | "ghost";

export interface GitInlineBannerAction extends BannerAction {}

interface GitInlineBannerProps {
  variant?: GitInlineBannerVariant;
  dismiss?: BannerDismiss | undefined;
  message: string;
  details?: string;
  actionLabel?: string;
  onAction?: () => void;
  actions?: GitInlineBannerAction[];
}

export function GitInlineBanner({
  variant = "info",
  dismiss,
  message,
  details,
  actionLabel,
  onAction,
  actions,
}: GitInlineBannerProps) {
  const resolvedActions =
    actions ?? (actionLabel && onAction ? [{ label: actionLabel, onAction }] : []);

  return (
    <Banner
      display="inline"
      variant={variant}
      dismiss={dismiss}
      message={message}
      details={details}
      actions={resolvedActions}
    />
  );
}
