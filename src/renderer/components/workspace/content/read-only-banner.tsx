import { useTranslation } from "react-i18next";
import { Banner } from "../../ui/banner";

interface ReadOnlyBannerProps {
  filePath: string;
  onRevealInFinder?: () => void;
}

export function ReadOnlyBanner({ onRevealInFinder }: ReadOnlyBannerProps) {
  const { t } = useTranslation();
  return (
    <Banner
      display="bar"
      variant="info"
      message={t("editor.read_only_message")}
      actions={
        onRevealInFinder ? [{ label: t("action.reveal_in_finder"), onAction: onRevealInFinder }] : []
      }
      role="status"
    />
  );
}
