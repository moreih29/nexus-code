import { Bot, Folder, GitBranch, NotebookPen, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { FilesPanelMode } from "../../state/stores/ui";
import { Button } from "../ui/button";

interface ModeButton {
  mode: FilesPanelMode;
  labelKey: string;
  Icon: typeof Folder;
}

const MODE_BUTTONS: readonly ModeButton[] = [
  { mode: "tree", labelKey: "files:panel.tab.tree", Icon: Folder },
  { mode: "search", labelKey: "files:panel.tab.search", Icon: Search },
  { mode: "git", labelKey: "files:panel.tab.git", Icon: GitBranch },
  { mode: "agents", labelKey: "files:panel.tab.agents", Icon: Bot },
  { mode: "notes", labelKey: "files:panel.tab.notes", Icon: NotebookPen },
];

export function FilesPanelModeBar<Mode extends FilesPanelMode>({
  modes,
  active,
  onSelect,
}: {
  modes?: readonly Mode[];
  active: Mode;
  onSelect: (mode: Mode) => void;
}) {
  const { t } = useTranslation("files");
  const shown = modes
    ? MODE_BUTTONS.filter((button) => (modes as readonly FilesPanelMode[]).includes(button.mode))
    : MODE_BUTTONS;
  return (
    <div className="flex items-center gap-1 px-2 pt-2 pb-2 border-b border-border/50">
      {shown.map(({ mode, labelKey, Icon }) => {
        const isActive = active === mode;
        const label = t(labelKey);
        return (
          <Button
            key={mode}
            variant="ghost"
            size="icon-sm"
            aria-pressed={isActive}
            tooltip={label}
            className={cn(
              "relative min-w-0 shrink",
              isActive && [
                "bg-[var(--sidebar-item-selected-bg)] text-foreground",
                "after:absolute after:right-1.5 after:bottom-0 after:left-1.5 after:h-0.5",
                "after:rounded-full after:bg-[var(--state-selected-indicator)] after:content-['']",
              ],
            )}
            onClick={() => onSelect(mode as Mode)}
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}
