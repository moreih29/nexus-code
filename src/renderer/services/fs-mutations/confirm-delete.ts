/**
 * confirmAndDeletePath — 파일/디렉터리 삭제 공통 helper.
 *
 * Uses showConfirmDialog (custom ConfirmDialog component) for user confirmation
 * before calling the appropriate deletion service. For directories, uses
 * removeDir (rmdir + removeAll fallback). For files/symlinks, uses unlinkPath.
 *
 * CRITICAL — 이 함수는 루트 경로 guard 를 포함하지 않는다.
 * 호출 측(use-file-tree-actions: isRoot check, 글로벌 핸들러: rootAbsPath 비교)
 * 에서 isRoot / 루트 판별 후 호출해야 한다.
 */

import { basename } from "@/utils/path";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { removeDir } from "./remove-dir";
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

  if (nodeType === "dir") {
    const ok = await showConfirmDialog({
      title: `Delete ${kindLabel}`,
      description: `Delete "${displayName}" and its contents?`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      variant: "destructive",
    });
    if (!ok) return false;
    return removeDir({ workspaceId, workspaceRootPath, absPath });
  }

  // files / symlinks — use simpler confirm message
  const ok = await showConfirmDialog({
    title: `Delete ${kindLabel}`,
    description: `Delete "${displayName}"?`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    variant: "destructive",
  });
  if (!ok) return false;
  return unlinkPath({ workspaceId, workspaceRootPath, absPath });
}
