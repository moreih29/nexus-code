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
