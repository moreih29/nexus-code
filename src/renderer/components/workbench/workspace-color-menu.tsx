// A workspace's "Color ›" submenu in the sidebar: "Auto" or one of the theme's
// lane colors, which tint the workspace's row and its agents in the agent view.

import { useTranslation } from "react-i18next";
import {
  WORKSPACE_COLOR_AUTO,
  WORKSPACE_COLORS,
  type WorkspaceColor,
  workspaceColorToken,
} from "../../../shared/types/workspace-color";
import {
  ContextMenuChoice,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "../ui/context-menu";

export function WorkspaceColorMenu({
  color,
  onSelect,
}: {
  color: WorkspaceColor;
  onSelect: (color: WorkspaceColor) => void;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <span>{t("sidebar.color")}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuChoice
          checked={color === WORKSPACE_COLOR_AUTO}
          onSelect={() => onSelect(WORKSPACE_COLOR_AUTO)}
        >
          <span>{t("sidebar.color_auto")}</span>
        </ContextMenuChoice>
        <ContextMenuSeparator />
        {WORKSPACE_COLORS.map((name) => (
          <ContextMenuChoice key={name} checked={color === name} onSelect={() => onSelect(name)}>
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ background: workspaceColorToken(name) ?? undefined }}
            />
            <span>{t(`sidebar.colors.${name}`)}</span>
          </ContextMenuChoice>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
