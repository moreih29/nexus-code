import i18next from "i18next";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { createLogger } from "../../../shared/log/renderer";

const log = createLogger("delete-batch");

import { showToast } from "@/components/ui/toast";
import { closeEditorTabsOfDeletedPath } from "@/services/editor/tabs";
import { useFilesStore } from "@/state/stores/files";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { basename } from "@/utils/path";
import { trashName } from "@/utils/trash-name";
import {
  type BatchFailure,
  partialFailureMessage,
  reportedFailure,
  thrownFailure,
} from "./batch-failure";
import { distinctParents } from "./distinct-parents";
import { removeDir } from "./remove-dir";
import { trashPath } from "./trash";
import { unlinkPath } from "./unlink";

export async function confirmAndDeletePath(
  workspaceId: string,
  workspaceRootPath: string,
  absPath: string,
  nodeType: "file" | "dir" | "symlink",
  name?: string,
): Promise<boolean> {
  const displayName = name ?? basename(absPath);
  const isDir = nodeType === "dir";

  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const useTrash = workspace?.location.kind === "local";

  const description = composeDescription({ displayName, isDir, useTrash });

  const ok = await showConfirmDialog({
    title: isDir
      ? i18next.t("files:fileTree.delete.titleFolder")
      : i18next.t("files:fileTree.delete.titleFile"),
    description,
    confirmLabel: deleteLabel(useTrash),
    variant: "destructive",
  });
  if (!ok) return false;

  const deleted = useTrash
    ? await trashPath({ workspaceId, workspaceRootPath, absPath, nodeType })
    : nodeType === "dir"
      ? await removeDir({ workspaceId, workspaceRootPath, absPath })
      : await unlinkPath({ workspaceId, workspaceRootPath, absPath });
  if (deleted) closeEditorTabsOfDeletedPath(workspaceId, absPath);
  return deleted;
}

interface DescriptionInput {
  displayName: string;
  isDir: boolean;
  useTrash: boolean;
}

function composeDescription({ displayName, isDir, useTrash }: DescriptionInput): string {
  const subject = isDir
    ? i18next.t("files:fileTree.delete.askFolder", { name: displayName })
    : i18next.t("files:fileTree.delete.askFile", { name: displayName });
  const consequence = useTrash
    ? isDir
      ? i18next.t("files:fileTree.delete.restoreFolder", { bin: trashName() })
      : i18next.t("files:fileTree.delete.restoreFile", { bin: trashName() })
    : i18next.t("files:fileTree.delete.permanent");
  return `${subject} ${consequence}`;
}

function deleteLabel(useTrash: boolean): string {
  return useTrash
    ? i18next.t("files:fileTree.delete.moveToTrash", { bin: trashName() })
    : i18next.t("common:action.delete");
}

export async function confirmAndDeleteBatch(
  workspaceId: string,
  workspaceRootPath: string,
  absPaths: readonly string[],
): Promise<boolean> {
  if (absPaths.length === 0) return false;

  const effective = distinctParents(absPaths);

  if (effective.length === 1) {
    const p = effective[0];
    const tree = useFilesStore.getState().trees.get(workspaceId);
    const nodeType = tree?.nodes.get(p)?.type ?? "file";
    return confirmAndDeletePath(workspaceId, workspaceRootPath, p, nodeType);
  }

  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const useTrash = workspace?.location.kind === "local";

  const N = effective.length;
  const names = effective.map((p) => basename(p));
  const suffix = useTrash
    ? i18next.t("files:fileTree.delete.restoreItems", { bin: trashName() })
    : i18next.t("files:fileTree.delete.permanent");

  let description: string;
  if (N <= 3) {
    description = `${names.join(", ")}\n${suffix}`;
  } else {
    const shown = names.slice(0, 3).join(", ");
    description = `${i18next.t("files:fileTree.delete.moreNames", { names: shown, count: N - 3 })}\n${suffix}`;
  }

  const ok = await showConfirmDialog({
    title: i18next.t("files:fileTree.delete.titleMany", { count: N }),
    description,
    confirmLabel: deleteLabel(useTrash),
    variant: "destructive",
  });
  if (!ok) return false;

  let successCount = 0;
  let firstFailure: BatchFailure | null = null;

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
      if (firstFailure === null) {
        firstFailure = thrownFailure(p, e);
      } else {
        log.error(`failed: ${p}: ${(e as Error).message}`);
      }
    }

    if (ok2) {
      successCount += 1;
      closeEditorTabsOfDeletedPath(workspaceId, p);
    } else if (firstFailure === null) {
      firstFailure = reportedFailure(p);
    } else {
      log.error(`failed: ${p}`);
    }
  }

  if (firstFailure === null) {
    showToast({ kind: "info", message: i18next.t("files:fileTree.delete.deleted", { count: N }) });
    return true;
  }

  showToast({
    kind: "error",
    message: partialFailureMessage(
      "files:fileTree.delete.deletedPartial",
      successCount,
      N,
      firstFailure,
    ),
  });
  return false;
}
