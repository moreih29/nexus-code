import { useTranslation } from "react-i18next";
import { type BannerScope, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { Banner } from "../ui/banner";

export function TerminalTwinBanner({
  scope,
  twin,
  onShow,
}: {
  scope: BannerScope;
  twin: string | null | undefined;
  onShow?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const { dismiss, dismissed } = useBannerDismissal(
    scope,
    twin ? [twin] : undefined,
    twin !== undefined,
  );
  if (!twin || dismissed) return null;
  return (
    <div className="shrink-0" data-testid="chat-terminal-twin">
      <Banner
        variant="warning"
        message={t("chat.twin.message")}
        dismiss={dismiss}
        {...(onShow ? { actions: [{ label: t("chat.twin.show"), onAction: onShow }] } : {})}
      />
    </div>
  );
}
