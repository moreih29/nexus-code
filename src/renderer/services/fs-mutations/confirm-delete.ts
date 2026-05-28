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
import { showToast } from "@/components/ui/toast";
import { useFilesStore } from "@/state/stores/files";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { basename } from "@/utils/path";
import { distinctParents } from "./distinct-parents";
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

// ---------------------------------------------------------------------------
// confirmAndDeleteBatch — delete multiple paths with a single confirm.
// ---------------------------------------------------------------------------

/**
 * Delete multiple paths from a workspace after a single user confirmation.
 *
 * Algorithm:
 *  1. Apply `distinctParents` to drop redundant descendants before confirming.
 *  2. Delegate to `confirmAndDeletePath` when only one effective path remains.
 *  3. For N≥2 show a batch-flavoured dialog, then attempt each path in order.
 *  4. Aggregate results: on full success show a success toast; on partial/full
 *     failure show an error toast with the first failure message.
 *
 * @param workspaceId      Current workspace ID.
 * @param workspaceRootPath Workspace root absolute path.
 * @param absPaths          Absolute paths to delete (duplicates + descendants
 *                          are collapsed via distinctParents before prompting).
 * @returns true when every path was deleted successfully, false otherwise.
 */
export async function confirmAndDeleteBatch(
  workspaceId: string,
  workspaceRootPath: string,
  absPaths: readonly string[],
): Promise<boolean> {
  if (absPaths.length === 0) return false;

  // Collapse descendants — operating on /a when /a/b is also selected is
  // correct (deleting the parent covers the child).
  const effective = distinctParents(absPaths);

  // Single-path: delegate to the existing helper so the message is identical
  // to the current single-delete UX.
  if (effective.length === 1) {
    const p = effective[0];
    // Determine node type for the single-path delegate.
    // Resolve from the workspace tree if available; fall back to "file"
    // (conservative — trashPath/unlinkPath work for both files and symlinks).
    const tree = useFilesStore.getState().trees.get(workspaceId);
    const nodeType = tree?.nodes.get(p)?.type ?? "file";
    return confirmAndDeletePath(workspaceId, workspaceRootPath, p, nodeType);
  }

  // Workspace kind — drives trash vs permanent semantics. SSH is permanent
  // unconditionally because there is no remote trash.
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const useTrash = workspace?.location.kind === "local";

  // Build dialog text.
  const N = effective.length;
  const names = effective.map((p) => basename(p));
  const suffix = useTrash ? "You can restore the items from the Trash." : "This cannot be undone.";

  let description: string;
  if (N <= 3) {
    description = `${names.join(", ")}\n${suffix}`;
  } else {
    description = `${names.slice(0, 3).join(", ")} and ${N - 3} more\n${suffix}`;
  }

  const ok = await showConfirmDialog({
    title: `Delete ${N} items`,
    description,
    confirmLabel: useTrash ? "Move to Trash" : "Delete",
    cancelLabel: "Cancel",
    variant: "destructive",
  });
  if (!ok) return false;

  // Execute deletions sequentially. Collect results.
  let successCount = 0;
  let firstFailurePath: string | null = null;
  let firstFailureMessage: string | null = null;

  // Snapshot the tree once before the loop — loadChildren may mutate it
  // between iterations but we only need each path's type at start time.
  const treeSnapshot = useFilesStore.getState().trees.get(workspaceId);

  for (const p of effective) {
    const nodeType = treeSnapshot?.nodes.get(p)?.type ?? "file";

    let ok2: boolean;
    try {
      if (useTrash) {
        ok2 = await trashPath({ workspaceId, workspaceRootPath, absPath: p, nodeType });
      } else if (nodeType === "dir") {
        ok2 = await removeDir({ workspaceId, workspaceRootPath, absPath: p });
      } else {
        ok2 = await unlinkPath({ workspaceId, workspaceRootPath, absPath: p });
      }
    } catch (e: unknown) {
      ok2 = false;
      if (firstFailurePath === null) {
        firstFailurePath = p;
        firstFailureMessage = e instanceof Error ? e.message : String(e);
      } else {
        console.error(`[delete-batch] failed: ${p}`, e);
      }
    }

    if (ok2) {
      successCount += 1;
    } else if (firstFailurePath === null) {
      // Per-path helpers already surface their own error toasts; record for summary.
      firstFailurePath = p;
      firstFailureMessage = `deletion failed`;
    } else {
      console.error(`[delete-batch] failed: ${p}`);
    }
  }

  const failCount = N - successCount;
  if (failCount === 0) {
    showToast({ kind: "info", message: `Deleted ${N} items` });
    return true;
  }

  showToast({
    kind: "error",
    message: `Deleted ${successCount} of ${N}. First failure: ${firstFailurePath}: ${firstFailureMessage}`,
  });
  return false;
}
