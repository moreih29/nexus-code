// Where a viewer that loads a workspace file by URL finds it.

import { buildOutsideUrl, buildWorkspaceUrl } from "../../../services/editor/preview/workspace-url";
import { useOutsideGranted } from "../../../state/stores/outside-grants";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { relPath } from "../../../utils/path";

export type WorkspaceFile =
  /** The workspace is gone, as for one render while it is removed. */
  | { readonly kind: "no-workspace" }
  /** The file is outside the workspace's root, which the protocol does not serve. */
  | { readonly kind: "outside" }
  | {
      readonly kind: "inside";
      /**
       * The path the workspace's fs reads it by: relative to the root, or
       * absolute for a file outside it that a Claude tab granted.
       */
      readonly relPath: string;
      readonly url: string;
    };

/**
 * The `nexus-workspace://` URL of `filePath` in `workspaceId`, local or SSH
 * alike. A file outside the root is served too while a Claude tab of the
 * workspace links it.
 */
export function useWorkspaceFile(workspaceId: string, filePath: string): WorkspaceFile {
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  const granted = useOutsideGranted(workspaceId, filePath);
  if (!location) return { kind: "no-workspace" };
  const root = location.kind === "local" ? location.rootPath : location.remotePath;
  const rel = relPath(filePath, root);
  // relPath gives back the absolute path for a file outside the root.
  if (rel === filePath) {
    if (!granted) return { kind: "outside" };
    return { kind: "inside", relPath: filePath, url: buildOutsideUrl(workspaceId, filePath) };
  }
  return { kind: "inside", relPath: rel, url: buildWorkspaceUrl(workspaceId, rel) };
}
