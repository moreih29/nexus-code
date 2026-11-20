// The workspace's context menu: pin, rename, color, profile and, where it applies, dismiss.
// The workbench sidebar and the agent view's workspace header share it.

import { useTranslation } from "react-i18next";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { WorkspaceColor } from "../../../shared/types/workspace-color";
import { WorkspaceProfileMenu } from "../agent-profiles/workspace-profile-menu";
import { ContextMenuContent, ContextMenuItems, ContextMenuSeparator } from "../ui/context-menu";
import type { ContextMenuHandoff } from "../ui/use-context-menu-handoff";
import { WorkspaceColorMenu } from "./workspace-color-menu";

export function WorkspaceMenuContent({
  workspace,
  handoff,
  onTogglePin,
  onRename,
  onColor,
  dismiss,
}: {
  workspace: WorkspaceMeta;
  handoff: ContextMenuHandoff;
  onTogglePin: () => void;
  onRename: () => void;
  onColor: (color: WorkspaceColor) => void;
  /** The notification reset, for a list that shows notifications. */
  dismiss?: { disabled: boolean; onSelect: () => void };
}) {
  const { t } = useTranslation();
  return (
    <ContextMenuContent onCloseAutoFocus={handoff.onCloseAutoFocus}>
      <ContextMenuItems
        items={[
          {
            kind: "item",
            label: workspace.pinned ? t("sidebar.unpin") : t("sidebar.pin_to_top"),
            onSelect: onTogglePin,
          },
          {
            kind: "item",
            label: t("sidebar.rename"),
            onSelect: () => handoff.defer(onRename),
          },
        ]}
      />
      <WorkspaceColorMenu color={workspace.color} onSelect={onColor} />
      <WorkspaceProfileMenu workspace={workspace} />
      {dismiss && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItems
            items={[
              {
                kind: "item",
                label: t("sidebar.dismiss_notification"),
                disabled: dismiss.disabled,
                onSelect: dismiss.onSelect,
              },
            ]}
          />
        </>
      )}
    </ContextMenuContent>
  );
}
