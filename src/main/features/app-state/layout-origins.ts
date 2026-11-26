import { toSlashPath } from "../../../shared/fs/drive-path";
import { windowsPathKind } from "../../../shared/fs/outside-url";
import { slashWindowsPath } from "../../../shared/fs/relative-path";
import { isWithinWorkspace } from "../../../shared/fs/workspace-path";
import type { AppState } from "../../../shared/types/app-state";
import type { SerializedTab } from "../../../shared/types/layout";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

function pathStyle(path: string): "posix" | "drive" | null {
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  if (/^[A-Z]:\//.test(path)) return "drive";
  return path.startsWith("/") && !path.startsWith("//") ? "posix" : null;
}

function slashedShareTab(tab: SerializedTab): SerializedTab {
  if (tab.type !== "editor" || windowsPathKind(tab.props.filePath) !== "unc") return tab;
  const filePath = slashWindowsPath(tab.props.filePath);
  return filePath === tab.props.filePath ? tab : { ...tab, props: { ...tab.props, filePath } };
}

function restoreTabOrigin(tab: SerializedTab, workspace: WorkspaceMeta): SerializedTab | null {
  if (tab.type !== "editor" || tab.props.origin !== undefined) return tab;
  const filePath = toSlashPath(tab.props.filePath);
  const root = toSlashPath(workspace.rootPath);
  const style = pathStyle(filePath);
  if (tab.props.workspaceId !== workspace.id || !style || style !== pathStyle(root)) return null;
  if (isWithinWorkspace(filePath, root)) return tab;
  if (
    workspace.location.kind !== "local" ||
    isWithinWorkspace(filePath.toLowerCase(), root.toLowerCase())
  ) {
    return null;
  }
  return { ...tab, props: { ...tab.props, filePath, origin: "external" } };
}

export function restoreLayoutOrigins(
  state: Readonly<AppState>,
  workspaces: WorkspaceMeta[],
): Readonly<AppState> {
  if (!state.layoutByWorkspace) return state;
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return {
    ...state,
    layoutByWorkspace: Object.fromEntries(
      Object.entries(state.layoutByWorkspace).flatMap(([id, snapshot]) => {
        const workspace = byId.get(id);
        if (!workspace) return [];
        const tabs = snapshot.tabs.flatMap(
          (tab) => restoreTabOrigin(slashedShareTab(tab), workspace) ?? [],
        );
        return [[id, { ...snapshot, tabs }]];
      }),
    ),
  };
}
