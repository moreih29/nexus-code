/**
 * The mark a row of the agent view's list carries while a panel holds its session, the
 * same for this computer's sessions and another computer's: a bar at the row's left edge,
 * bright where a panel shows the session in front, dim where another tab is in front of it.
 * A shown row has the selected background too (`PANEL_SHOWN_BG`), as a workspace's does.
 */
import { useTranslation } from "react-i18next";
import type { SplitNode } from "@/engine";
import { leafHolding, leafShowing } from "../../services/agent-view/layout";
import { cn } from "../../utils/cn";

/** Where the panels have a session: in front in one, or behind another tab. */
export type PanelPlace = "shown" | "held";

/** Where the panels in `root` have the session `key`; null where none holds it. */
export function panelPlaceOf(root: SplitNode, key: string): PanelPlace | null {
  return leafShowing(root, key) !== null ? "shown" : leafHolding(root, key) ? "held" : null;
}

/** A shown row's background. */
export const PANEL_SHOWN_BG = "bg-[var(--sidebar-item-selected-bg)]";

export function PanelMark({
  where,
  className,
  testId,
}: {
  where: PanelPlace;
  /** Its top and bottom, to sit inside its row's padding. */
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
