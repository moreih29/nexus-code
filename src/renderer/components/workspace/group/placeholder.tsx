import { useTranslation } from "react-i18next";
import { shortcutFor } from "@/keybindings/shortcut-labels";
import { COMMANDS } from "../../../../shared/keybindings/commands";

export function GroupPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 flex flex-col items-center pt-12 gap-1 pointer-events-none select-none">
      <span className="text-app-ui-sm text-stone-gray">{t("groupPlaceholder.no_tab")}</span>
      <span className="text-app-ui-sm text-muted-foreground">
        {t("groupPlaceholder.new_terminal", { shortcut: shortcutFor(COMMANDS.terminalNew) ?? "" })}
      </span>
      <span className="text-app-ui-sm text-muted-foreground">
        {t("groupPlaceholder.open_split", { shortcut: shortcutFor(COMMANDS.openToSide) ?? "" })}
      </span>
    </div>
  );
}
