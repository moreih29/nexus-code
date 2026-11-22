import { useTranslation } from "react-i18next";
import { revealInOSLabel } from "../../../utils/reveal-label";
import { Banner, type BannerDismiss } from "../../ui/banner";

interface ReadOnlyBannerProps {
  dismiss?: BannerDismiss;
  onRevealInFinder?: () => void;
}

export function ReadOnlyBanner({ dismiss, onRevealInFinder }: ReadOnlyBannerProps) {
  const { t } = useTranslation();
  return (
    <Banner
      display="bar"
      dismiss={dismiss}
      variant="info"
      message={t("editor.read_only_message")}
      actions={onRevealInFinder ? [{ label: revealInOSLabel(), onAction: onRevealInFinder }] : []}
      role="status"
    />
  );
}
