import { buildOutsideUrl, buildWorkspaceUrl } from "../../../services/editor/preview/workspace-url";
import { peerOf } from "../../../services/remote/peer-workspace";
import { useOutsideGranted } from "../../../state/stores/outside-grants";
import { useWorkspace } from "../../../state/stores/workspaces";
import { relativeTo } from "../../../utils/path";
import { usePreviewDraft } from "./preview-draft";

export type WorkspaceFile =
  | { readonly kind: "no-workspace" }
  | { readonly kind: "outside" }
  | {
      readonly kind: "inside";
      readonly relPath: string;
      readonly url: string;
    };

export function useWorkspaceFile(workspaceId: string, filePath: string): WorkspaceFile {
  const location = useWorkspace(workspaceId, (w) => w?.location);
  const granted = useOutsideGranted(workspaceId, filePath);
  const draft = usePreviewDraft();
  if (draft) return { kind: "inside", relPath: filePath, url: draft.url };
  if (peerOf(workspaceId)) {
    return { kind: "inside", relPath: filePath, url: buildOutsideUrl(workspaceId, filePath) };
  }
  if (!location) return { kind: "no-workspace" };
  const root = location.kind === "local" ? location.rootPath : location.remotePath;
  const rel = relativeTo(filePath, root);
  if (rel === filePath) {
    if (!granted) return { kind: "outside" };
    return { kind: "inside", relPath: filePath, url: buildOutsideUrl(workspaceId, filePath) };
  }
  return { kind: "inside", relPath: rel, url: buildWorkspaceUrl(workspaceId, rel) };
}
