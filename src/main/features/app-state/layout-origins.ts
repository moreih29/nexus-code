import { toSlashPath } from "../../../shared/fs/drive-path";
import { isWithinWorkspace } from "../../../shared/fs/workspace-path";
import type { AppState } from "../../../shared/types/app-state";
import type { SerializedTab } from "../../../shared/types/layout";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

/** Recognize absolute paths in the formats Open File stores. */
function pathStyle(path: string): "posix" | "drive" | null {
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  if (/^[A-Z]:\//.test(path)) return "drive";
  return path.startsWith("/") && !path.startsWith("//") ? "posix" : null;
}

/**
 * Restore a legacy file tab using Open File's containment check. A remote
 * or ambiguous path cannot establish that the file is safe to route to the
 * local external loader. Omit it so the user can reopen it explicitly.
 */
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

/** Upgrade origin-less records on read, once workspace metadata is available. */
export function restoreLayoutOrigins(
  state: Readonly<AppState>,
  workspaces: WorkspaceMeta[],
): Readonly<AppState> {
  if (!state.layoutByWorkspace) return state;
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return {
    ...state,
    layoutByWorkspace: Object.fromEntries(
      Object.entries(state.layoutByWorkspace).map(([id, snapshot]) => {
        const workspace = byId.get(id);
        if (!workspace) return [id, snapshot];
        const tabs = snapshot.tabs.flatMap((tab) => restoreTabOrigin(tab, workspace) ?? []);
        return [id, { ...snapshot, tabs }];
      }),
    ),
  };
}
