/**
 * Paste previously copied/cut entries into a destination folder.
 *
 * Behaviour by clipboard kind:
 *  - "cut":  move each entry via `movePath`.
 *  - "copy": copy each entry via `copyPathWithAutoRename` (auto-rename on
 *            conflict when the destination already exists).
 *  - null:   no-op.
 *
 * Phase D changes:
 *  - `distinctParents` is applied to cb.entries on entry so redundant
 *    descendants are dropped before iterating.
 *  - Cycle guard: a cut/copy of a folder into itself or a descendant
 *    skips that entry with a per-item error toast rather than aborting
 *    the whole batch.
 *  - Partial failure collection: per-entry try/catch produces a
 *    summary toast at the end (info "Pasted N items" or error "Pasted M of N").
 *  - Cut clears the clipboard only when at least one entry was moved.
 */

import { showToast } from "@/components/ui/toast";
import { createLogger } from "../../../shared/log/renderer";

const log = createLogger("paste");

import { loadChildren } from "@/state/operations/files";
import { useActiveStore } from "@/state/stores/active";
import { selectFocus, useFilesStore } from "@/state/stores/files";
import { parentOf } from "@/state/stores/files/helpers";
import { basename, relPath } from "@/utils/path";
import { copyPathWithAutoRename, movePath } from "../fs-mutations";
import { distinctParents } from "../fs-mutations/distinct-parents";
import type { ClipboardEntry } from "./store";
import { useFileClipboardStore } from "./store";

/** True when `candidate` is `ancestor` itself or sits under it. */
function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/**
 * Re-order a ClipboardEntry list so that it contains only the minimal
 * ancestor set.  Entries are kept by absPath identity so their stored
 * relPath values are preserved after filtering.
 */
function applyDistinctParents(entries: ClipboardEntry[]): ClipboardEntry[] {
  const kept = new Set(distinctParents(entries.map((e) => e.absPath)));
  return entries.filter((e) => kept.has(e.absPath));
}

/**
 * Paste the clipboard contents into a destination folder.
 *
 * @param targetAbsPath  The node the paste was invoked on. A directory pastes
 *   into itself; a file pastes into its containing folder. When omitted (e.g.
 *   the keyboard shortcut with no explicit target) the file-tree's current
 *   focus is used, falling back to the workspace root.
 */
export async function handlePaste(targetAbsPath?: string | null): Promise<void> {
  const cb = useFileClipboardStore.getState();
  if (!cb.kind || cb.entries.length === 0) return;

  // Cross-workspace guard — if the clipboard workspace doesn't match the
  // active workspace, clear and no-op.
  const activeId = useActiveStore.getState().activeWorkspaceId;
  if (cb.workspaceId !== activeId) {
    useFileClipboardStore.getState().clear();
    return;
  }

  // Resolve the target directory. Prefer the explicit paste target (context
  // menu); otherwise fall back to the file-tree's current focus.
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

  // Apply distinctParents: drop redundant descendants from the clipboard
  // before iterating so we don't operate on both a parent and its child.
  const effectiveEntries = applyDistinctParents(cb.entries);
  const total = effectiveEntries.length;

  // Track which directories need a refresh at the end.
  const dirsToRefresh = new Set<string>();

  // Result accumulators.
  let successCount = 0;
  let firstFailurePath: string | null = null;
  let firstFailureMessage: string | null = null;

  if (kind === "cut") {
    for (const entry of effectiveEntries) {
      // Cycle guard: moving a folder into itself or a descendant is invalid.
      if (isInsideOrEqual(targetDir, entry.absPath)) {
        const msg = `Can't move "${basename(entry.absPath)}" into itself or a subfolder.`;
        showToast({ kind: "error", message: msg });
        if (firstFailurePath === null) {
          firstFailurePath = entry.absPath;
          firstFailureMessage = msg;
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
        if (firstFailurePath === null) {
          firstFailurePath = entry.absPath;
          firstFailureMessage = e instanceof Error ? e.message : String(e);
        } else {
          log.error(`move failed: ${entry.absPath}: ${(e as Error).message}`);
        }
      }

      if (ok) {
        successCount += 1;
        dirsToRefresh.add(targetDir);
      } else if (firstFailurePath === null) {
        // movePath already surfaced a per-item error toast; record for summary.
        firstFailurePath = entry.absPath;
        firstFailureMessage = "move failed";
      }
    }
  } else {
    // kind === "copy"
    for (const entry of effectiveEntries) {
      const name = basename(entry.absPath);
      // VSCode parity: if the user copies a folder and then pastes onto that
      // same folder (or anywhere inside it), the destination falls back to the
      // folder's PARENT — so the result is a sibling "B copy" rather than a
      // recursive "B/B/B/…" tree.
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
        if (firstFailurePath === null) {
          firstFailurePath = entry.absPath;
          firstFailureMessage = e instanceof Error ? e.message : String(e);
        } else {
          log.error(`copy failed: ${entry.absPath}: ${(e as Error).message}`);
        }
      }

      if (ok) {
        successCount += 1;
        dirsToRefresh.add(effectiveDir);
      } else if (firstFailurePath === null) {
        firstFailurePath = entry.absPath;
        firstFailureMessage = "copy failed";
      }
    }
  }

  // Refresh all touched directories.
  for (const dir of dirsToRefresh) {
    await loadChildren(cb.workspaceId, dir);
  }

  // Cut: clear clipboard when at least one item was moved successfully.
  if (kind === "cut" && successCount > 0) {
    useFileClipboardStore.getState().clear();
  }

  // Aggregate result toast.
  const failCount = total - successCount;
  if (failCount === 0) {
    // N=1 single paste: no toast (matches single-delete no-toast convention).
    if (total > 1) {
      showToast({ kind: "info", message: `Pasted ${total} items` });
    }
  } else {
    showToast({
      kind: "error",
      message: `Pasted ${successCount} of ${total}. First failure: ${firstFailurePath}: ${firstFailureMessage}`,
    });
  }
}
