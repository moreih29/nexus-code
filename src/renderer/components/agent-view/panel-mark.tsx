import { useTranslation } from "react-i18next";
import type { SplitNode } from "@/engine";
import { leafHolding, leafShowing } from "../../services/agent-view/layout";
import { cn } from "../../utils/cn";

export type PanelPlace = "shown" | "held";

export function panelPlaceOf(root: SplitNode, key: string): PanelPlace | null {
  return leafShowing(root, key) !== null ? "shown" : leafHolding(root, key) ? "held" : null;
}

export const PANEL_SHOWN_BG = "bg-[var(--sidebar-item-selected-bg)]";

export function PanelMark({
  where,
  className,
  testId,
}: {
  where: PanelPlace;
  className?: string;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t(where === "shown" ? "agentView.list.shown" : "agentView.list.held")}
      className={cn(
        "pointer-events-none absolute top-1.5 bottom-1.5 left-px w-0.5 rounded-full",
        where === "shown" ? "bg-[var(--state-selected-indicator)]" : "bg-muted-foreground/60",
        className,
      )}
      data-testid={testId}
      data-where={where}
    />
  );
}
