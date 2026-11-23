import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";

export function BrowserEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <div className="text-muted-foreground">
        <Globe className="size-10" aria-hidden="true" />
      </div>
      <p className="text-app-ui-sm text-muted-foreground">{t("browser.enter_url")}</p>
    </div>
  );
}
