import { GitBranch, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentListView } from "../../../shared/agent-list/view";

const VIEW_ICONS: Record<AgentListView, typeof List> = { status: List, task: GitBranch };

export function ViewSwitch({
  view,
  onChange,
}: {
  view: AgentListView;
  onChange: (view: AgentListView) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      aria-label={t("agentList.view_label")}
      className="flex shrink-0 items-center gap-0.5 rounded-(--radius-control) border border-border p-0.5"
    >
      {(["status", "task"] as const).map((each) => {
        const Icon = VIEW_ICONS[each];
        const label = t(`agentList.view.${each}`);
        return (
          <button
            key={each}
            type="button"
            aria-pressed={view === each}
            title={label}
            aria-label={label}
            onClick={() => onChange(each)}
            className={cn(
              "flex size-6 items-center justify-center rounded-[calc(var(--radius-control)-2px)] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
              view === each
                ? "bg-[var(--sidebar-item-selected-bg)] text-foreground"
                : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        );
      })}
    </fieldset>
  );
}
