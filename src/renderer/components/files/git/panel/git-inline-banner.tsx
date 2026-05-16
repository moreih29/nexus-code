/**
 * GitInlineBanner — re-export shim over the generic Banner primitive.
 *
 * Callers (git-panel.tsx, history/panel.tsx) continue to import GitInlineBanner
 * unchanged. The implementation now delegates to Banner so the visual contract
 * stays consistent with other inline notices across the app.
 */
import { Banner, type BannerAction, type BannerVariant } from "../../../ui/banner";

export type GitInlineBannerVariant = BannerVariant;
export type GitInlineBannerActionVariant = "default" | "destructive" | "ghost";

export interface GitInlineBannerAction extends BannerAction {}

interface GitInlineBannerProps {
  variant?: GitInlineBannerVariant;
  message: string;
  details?: string;
  actionLabel?: string;
  onAction?: () => void;
  actions?: GitInlineBannerAction[];
}

export function GitInlineBanner({
  variant = "info",
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
      message={message}
      details={details}
      actions={resolvedActions}
    />
  );
}
