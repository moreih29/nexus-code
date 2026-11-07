// The title bar's button for the agent manager's dock, in either view: it
// counts the manager's answers that came while the dock was shut.

import { useTranslation } from "react-i18next";
import { useManagerStore } from "../../state/stores/manager";
import { cn } from "../../utils/cn";
import { ManagerIcon } from "./manager-chip";

export function ManagerButton() {
  const { t } = useTranslation();
  const open = useManagerStore((s) => s.dockOpen);
  const unread = useManagerStore((s) => s.unread);
  return (
    <button
      type="button"
      onClick={() => useManagerStore.getState().setDockOpen(!open)}
      aria-pressed={open}
      aria-label={unread > 0 ? t("manager.button_unread", { count: unread }) : t("manager.title")}
      title={t("manager.title")}
      className={cn(
        "app-no-drag mr-1.5 flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-app-ui-sm",
        open
          ? "border-[var(--state-selected-indicator)] text-foreground"
          : "border-border text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
      )}
      data-testid="manager-button"
    >
      <ManagerIcon className="size-3.5 text-[var(--state-selected-indicator)]" aria-hidden="true" />
      <span>{t("manager.button")}</span>
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-(--state-warning-fg) px-1 text-app-micro font-semibold leading-none text-background tabular-nums"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}
