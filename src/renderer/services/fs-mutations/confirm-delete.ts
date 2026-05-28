/**
 * confirmAndDeletePath — 파일/디렉터리 삭제 공통 helper.
 *
 * Branches on workspace kind so the user sees a confirm message that
 * matches what's actually about to happen — VSCode parity:
 *   - Local workspace → moves to the OS Trash (recoverable). Confirm
 *     text reads "You can restore it from the Trash."
 *   - SSH workspace   → permanent delete (no remote trash). Confirm text
 *     reads "This cannot be undone." and the action runs `fs.removeAll`
 *     / `fs.unlink` directly.
 *
 * Uses showConfirmDialog (custom ConfirmDialog component) for user
 * confirmation. For directories on the SSH path, falls through to
 * removeDir (which calls fs.removeAll). For files/symlinks on the SSH
 * path, falls through to unlinkPath.
 *
 * CRITICAL — 이 함수는 루트 경로 guard 를 포함하지 않는다.
 * 호출 측(use-file-tree-actions: isRoot check, 글로벌 핸들러: rootAbsPath 비교)
 * 에서 isRoot / 루트 판별 후 호출해야 한다.
 */

import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { basename } from "@/utils/path";
import { removeDir } from "./remove-dir";
import { trashPath } from "./trash";
import { unlinkPath } from "./unlink";

/**
 * @param workspaceId    현재 워크스페이스 ID.
 * @param workspaceRootPath   워크스페이스 루트 절대 경로.
 * @param absPath        삭제 대상 절대 경로.
 * @param nodeType       "file" | "dir" | "symlink"
 * @param name           confirm 다이얼로그용 이름 (기본값: basename(absPath)).
 * @returns              삭제 성공 시 true, confirm 취소 또는 IPC 실패 시 false.
 */
export async function confirmAndDeletePath(
  workspaceId: string,
  workspaceRootPath: string,
  absPath: string,
  nodeType: "file" | "dir" | "symlink",
  name?: string,
): Promise<boolean> {
  const displayName = name ?? basename(absPath);
  const kindLabel = nodeType === "dir" ? "folder" : "file";

  // Workspace kind drives the deletion semantics: local goes through the
  // OS trash (recoverable), SSH goes through agent removeAll/unlink
  // (permanent — there's no host trash on the remote side).
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const useTrash = workspace?.location.kind === "local";

  const description = composeDescription({
    displayName,
    kindLabel,
    isDir: nodeType === "dir",
    useTrash,
  });

  const ok = await showConfirmDialog({
    title: `Delete ${kindLabel}`,
    description,
    confirmLabel: useTrash ? "Move to Trash" : "Delete",
    cancelLabel: "Cancel",
    variant: "destructive",
  });
  if (!ok) return false;

  if (useTrash) {
    return trashPath({ workspaceId, workspaceRootPath, absPath, nodeType });
  }

  // SSH path — permanent. Directory: removeAll (already collapses the
  // empty/non-empty distinction); file/symlink: unlink.
  if (nodeType === "dir") {
    return removeDir({ workspaceId, workspaceRootPath, absPath });
  }
  return unlinkPath({ workspaceId, workspaceRootPath, absPath });
}

interface DescriptionInput {
  displayName: string;
  kindLabel: string;
  isDir: boolean;
  useTrash: boolean;
}

function composeDescription({ displayName, kindLabel, isDir, useTrash }: DescriptionInput): string {
  const subject = isDir ? `Delete "${displayName}" and its contents?` : `Delete "${displayName}"?`;
  const consequence = useTrash
    ? `You can restore the ${kindLabel} from the Trash.`
    : "This cannot be undone.";
  return `${subject} ${consequence}`;
}
