import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { createLogger } from "../../../shared/log/renderer";

const log = createLogger("paste");

import { loadChildren } from "@/state/operations/files";
import { useActiveStore } from "@/state/stores/active";
import { selectFocus, useFilesStore } from "@/state/stores/files";
import { parentOf } from "@/state/stores/files/helpers";
import { basename, relPath } from "@/utils/path";
import { copyPathWithAutoRename, movePath } from "../fs-mutations";
import {
  type BatchFailure,
  partialFailureMessage,
  reportedFailure,
  thrownFailure,
} from "../fs-mutations/batch-failure";
import { distinctParents } from "../fs-mutations/distinct-parents";
import type { ClipboardEntry } from "./store";
import { useFileClipboardStore } from "./store";

function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

function applyDistinctParents(entries: ClipboardEntry[]): ClipboardEntry[] {
  const kept = new Set(distinctParents(entries.map((e) => e.absPath)));
  return entries.filter((e) => kept.has(e.absPath));
}

export async function handlePaste(targetAbsPath?: string | null): Promise<void> {
  const cb = useFileClipboardStore.getState();
  if (!cb.kind || cb.entries.length === 0) return;

  const activeId = useActiveStore.getState().activeWorkspaceId;
  if (cb.workspaceId !== activeId) {
    useFileClipboardStore.getState().clear();
    return;
  }

  const tree = useFilesStore.getState().trees.get(cb.workspaceId);
  if (!tree) return;
  const rootAbsPath = tree.rootAbsPath;

  const candidate = targetAbsPath ?? selectFocus(useFilesStore.getState(), cb.workspaceId) ?? null;
  let targetDir: string;
  if (candidate === null) {
    targetDir = rootAbsPath;
  } else {
    const node = tree.nodes.get(candidate);
    if (node?.type === "dir") {
      targetDir = candidate;
    } else {
      targetDir = parentOf(candidate, rootAbsPath);
    }
  }

  const kind = cb.kind;

  const effectiveEntries = applyDistinctParents(cb.entries);
  const total = effectiveEntries.length;

  const dirsToRefresh = new Set<string>();

  let successCount = 0;
  let firstFailure: BatchFailure | null = null;

  if (kind === "cut") {
    for (const entry of effectiveEntries) {
      if (isInsideOrEqual(targetDir, entry.absPath)) {
        showToast({
          kind: "error",
          message: i18next.t("files:fileTree.paste.cycleError", { name: basename(entry.absPath) }),
        });
        if (firstFailure === null) {
          firstFailure = reportedFailure(entry.absPath);
        } else {
          log.error(`cycle: ${entry.absPath}`);
        }
        continue;
      }

      let ok = false;
      try {
        ok = await movePath({
          workspaceId: cb.workspaceId,
          workspaceRootPath: cb.sourceRootPath,
          srcAbsPath: entry.absPath,
          dstDirAbsPath: targetDir,
        });
      } catch (e: unknown) {
        ok = false;
        if (firstFailure === null) {
          firstFailure = thrownFailure(entry.absPath, e);
        } else {
          log.error(`move failed: ${entry.absPath}: ${(e as Error).message}`);
        }
      }

      if (ok) {
        successCount += 1;
        dirsToRefresh.add(targetDir);
      } else if (firstFailure === null) {
        firstFailure = reportedFailure(entry.absPath);
      }
    }
  } else {
    for (const entry of effectiveEntries) {
      const name = basename(entry.absPath);
      const effectiveDir = isInsideOrEqual(targetDir, entry.absPath)
        ? parentOf(entry.absPath, cb.sourceRootPath)
        : targetDir;
      const dstAbsPath = `${effectiveDir}/${name}`;
      const toRel = relPath(dstAbsPath, cb.sourceRootPath);

      let ok = false;
      try {
        ok = await copyPathWithAutoRename({
          workspaceId: cb.workspaceId,
          fromRelPath: entry.relPath,
          toRelPath: toRel,
        });
      } catch (e: unknown) {
        ok = false;
        if (firstFailure === null) {
          firstFailure = thrownFailure(entry.absPath, e);
        } else {
          log.error(`copy failed: ${entry.absPath}: ${(e as Error).message}`);
        }
      }

      if (ok) {
        successCount += 1;
        dirsToRefresh.add(effectiveDir);
      } else if (firstFailure === null) {
        firstFailure = reportedFailure(entry.absPath);
      }
    }
  }

  for (const dir of dirsToRefresh) {
    await loadChildren(cb.workspaceId, dir);
  }

  if (kind === "cut" && successCount > 0) {
    useFileClipboardStore.getState().clear();
  }

  if (firstFailure === null) {
    if (total > 1) {
      showToast({
        kind: "info",
        message: i18next.t("files:fileTree.paste.pasted", { count: total }),
      });
    }
  } else {
    showToast({
      kind: "error",
      message: partialFailureMessage(
        "files:fileTree.paste.pastedPartial",
        successCount,
        total,
        firstFailure,
      ),
    });
  }
}
