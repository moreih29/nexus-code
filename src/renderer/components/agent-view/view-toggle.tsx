// The title bar's switch between the two views of the window: the workspaces,
// one at a time with their files, terminals and tabs, and the agent view,
// the agents of every workspace side by side. It sits right of the brand in
// both, clear of the workspace name the title bar centers.

import { Bot, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { COMMANDS } from "../../../shared/keybindings/commands";
import type { AgentViewMode } from "../../../shared/types/agent-view";
import { shortcutFor } from "../../keybindings/shortcut-labels";
import { useInbox } from "../../services/agent-sessions/use-inbox";
import { switchView } from "../../services/agent-view/show";
import { useAgentViewStore } from "../../state/stores/agent-view";

export function ViewToggle() {
  const { t } = useTranslation();
  const mode = useAgentViewStore((s) => s.mode);
  // An agent waiting on the user shows from the workspaces too.
  const waiting = useInbox().attention > 0;
  const shortcut = shortcutFor(COMMANDS.workbenchToggleAgentView);
  const option = (value: AgentViewMode, label: string, icon: React.ReactNode, dot = false) => {
    const on = mode === value;
    return (
      <button
        type="button"
        aria-pressed={on}
        title={shortcut ? `${label} (${shortcut})` : label}
        onClick={() => switchView(value)}
        className={cn(
          "flex h-5 items-center gap-1.5 rounded-[calc(var(--radius-control)-1px)] px-2 text-app-ui-sm transition-colors duration-150",
          on
            ? "bg-[var(--state-active-bg)] text-foreground"
            : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        )}
      >
        {icon}
        <span>{label}</span>
        {dot && (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-(--state-warning-fg)"
          />
        )}
      </button>
    );
  };
  return (
    <fieldset
      aria-label={t("agentView.toggle.aria")}
      className="app-no-drag ml-3 flex items-center gap-0.5 rounded-(--radius-control) border border-border p-0.5"
      data-testid="view-toggle"
    >
      {option(
        "workspace",
        t("agentView.toggle.workspaces"),
        <Folder aria-hidden className="size-3.5 shrink-0" />,
      )}
      {option(
        "agents",
        t("agentView.toggle.agents"),
        <Bot aria-hidden className="size-3.5 shrink-0" />,
        waiting,
      )}
    </fieldset>
  );
}
