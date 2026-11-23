import { useTranslation } from "react-i18next";
import { Banner, type BannerDismiss } from "../../ui/banner";

export function shouldShowConflictResolvedBanner(
  isConflicted: boolean,
  hasMarkers: boolean,
): boolean {
  return isConflicted && !hasMarkers;
}

interface ConflictResolvedBannerProps {
  dismiss?: BannerDismiss;
  isConflicted: boolean;
  hasMarkers: boolean;
  onMarkResolved: () => void;
}

export function ConflictResolvedBanner({
  dismiss,
  isConflicted,
  hasMarkers,
  onMarkResolved,
}: ConflictResolvedBannerProps) {
  const { t } = useTranslation();
  if (!shouldShowConflictResolvedBanner(isConflicted, hasMarkers)) return null;

  return (
    <Banner
      display="bar"
      dismiss={dismiss}
      variant="success"
      message={t("editor.conflicts_resolved")}
      actions={[{ label: t("action.mark_resolved"), onAction: onMarkResolved }]}
      role="status"
      aria-live="polite"
    />
  );
}
