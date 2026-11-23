import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { openOrRevealEditor } from "@/services/editor";
import {
  handleCopy,
  handleCut,
  handlePaste,
  useFileClipboardStore,
} from "@/services/file-clipboard";
import { confirmAndDeleteBatch, createPathActions, distinctParents } from "@/services/fs-mutations";
import { parentOf } from "@/state/stores/files";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { relativeTo } from "@/utils/path";
import type { EntryKind } from "../file-tree/display";

export interface FileTreeActionTarget {
  absPath: string;
  type: "file" | "dir" | "symlink";
  isRoot?: boolean;
}

interface UseFileTreeActionsOptions {
  workspaceId: string;
  rootAbsPath: string;
  getTargets: () => FileTreeActionTarget[];
  startCreate: (parentAbsPath: string, kind: EntryKind) => void;
  startRename: (absPath: string) => void;
}

export function useFileTreeActions({
  workspaceId,
  rootAbsPath,
  getTargets,
  startCreate,
  startRename,
}: UseFileTreeActionsOptions) {
  const pathActions = createPathActions({
    workspaceId,
    workspaceRootPath: rootAbsPath,
    getAbsPath: () => getTargets()[0]?.absPath ?? null,
  });

  function resolveCreateParent(): string {
    const ts = getTargets();
    const t = ts[0];
    if (!t) return rootAbsPath;
    if (t.type === "dir") return t.absPath;
    return parentOf(t.absPath, rootAbsPath);
  }

  function open() {
    const ts = getTargets();
    const t = ts[0];
    if (!t || t.type !== "file") return;
    openOrRevealEditor({ workspaceId, filePath: t.absPath });
  }

  function openToSide() {
    const ts = getTargets();
    const t = ts[0];
    if (!t || t.type !== "file") return;
    openOrRevealEditor(
      { workspaceId, filePath: t.absPath },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );
  }

  function newFile() {
    startCreate(resolveCreateParent(), "file");
  }

  function newFolder() {
    startCreate(resolveCreateParent(), "folder");
  }

  function rename() {
    const ts = getTargets();
    if (ts.length > 1) {
      showToast({ kind: "info", message: i18next.t("files:fileTree.renameOneAtATime") });
      return;
    }
    const t = ts[0];
    if (!t || t.isRoot) return;
    startRename(t.absPath);
  }

  async function deleteTarget(): Promise<boolean> {
    const ts = getTargets();
    const deletable = ts.filter((t) => !t.isRoot);
    if (deletable.length === 0) return false;

    return confirmAndDeleteBatch(
      workspaceId,
      rootAbsPath,
      deletable.map((t) => t.absPath),
    );
  }

  function copy() {
    const ts = getTargets();
    const copyable = ts.filter((t) => !t.isRoot);
    if (copyable.length === 0) return;

    const absPaths = distinctParents(copyable.map((t) => t.absPath));
    const entries = absPaths.map((abs) => ({
      relPath: relativeTo(abs, rootAbsPath),
      absPath: abs,
    }));

    handleCopy({ workspaceId, workspaceRootPath: rootAbsPath, entries });

    if (entries.length >= 2) {
      showToast({
        kind: "info",
        message: i18next.t("files:fileTree.clipboard.copied", { count: entries.length }),
      });
    }
  }

  function cut() {
    const ts = getTargets();
    const cuttable = ts.filter((t) => !t.isRoot);
    if (cuttable.length === 0) return;

    const absPaths = distinctParents(cuttable.map((t) => t.absPath));
    const entries = absPaths.map((abs) => ({
      relPath: relativeTo(abs, rootAbsPath),
      absPath: abs,
    }));

    handleCut({ workspaceId, workspaceRootPath: rootAbsPath, entries });

    if (entries.length >= 2) {
      showToast({
        kind: "info",
        message: i18next.t("files:fileTree.clipboard.cut", { count: entries.length }),
      });
    }
  }

  function paste() {
    const ts = getTargets();
    const t = ts[0];
    void handlePaste(t?.absPath ?? null);
  }

  const clip = useFileClipboardStore.getState();
  const canPaste = clip.kind !== null && clip.entries.length > 0;
  const isRemote =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.location.kind ===
    "ssh";

  return {
    open,
    openToSide,
    copyPath: pathActions.copyPath,
    copyRelativePath: pathActions.copyRelativePath,
    reveal: isRemote ? undefined : pathActions.revealInFinder,
    newFile,
    newFolder,
    rename,
    delete: deleteTarget,
    copy,
    cut,
    paste,
    canPaste,
  };
}
