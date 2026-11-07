// What marks the agent manager's work: its glyph, and the chip on a session
// it handed work to.

import { Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

export const ManagerIcon = Network;

/** On a session of the manager's tasks. */
export function ManagerChip({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      title={t("manager.task_title")}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 leading-4 text-[var(--state-selected-indicator)]",
        className,
      )}
    >
      <ManagerIcon className="size-3" aria-hidden="true" />
      <span className="text-muted-foreground">{t("manager.chip")}</span>
    </span>
  );
}
