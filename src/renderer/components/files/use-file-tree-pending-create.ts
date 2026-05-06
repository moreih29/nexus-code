/**
 * State + transitions for an in-flight inline-create row.
 *
 * Keeps the state machine out of file-tree.tsx so the component just
 * mounts / unmounts the edit row and forwards user intent through
 * `startCreate` / `commit` / `cancel`.
 *
 * Commit is async (IPC + tree refresh) — the hook returns the commit
 * outcome so the row can decide whether to clear pending state or keep
 * the input open for retry.
 */

import { useCallback, useState } from "react";
import { createNewFile, createNewFolder } from "@/services/fs-mutations";
import { toggleExpand } from "@/state/operations/files";
import { useFilesStore } from "@/state/stores/files";
import type { EntryKind, PendingCreate } from "./file-tree-display";

interface UseFileTreePendingCreateOptions {
  workspaceId: string;
  rootAbsPath: string;
}

/**
 * Toggle the parent open if it isn't already, so the inline-edit row is
 * visible when the pending sentinel is injected. The workspace root is
 * always rendered as expanded by the tree, so we skip the toggle in
 * that case.
 */
function expandIfCollapsed(workspaceId: string, parentAbsPath: string): void {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;
  if (parentAbsPath === tree.rootAbsPath) return;
  if (tree.expanded.has(parentAbsPath)) return;
  toggleExpand(workspaceId, parentAbsPath);
}

export function useFileTreePendingCreate({
  workspaceId,
  rootAbsPath,
}: UseFileTreePendingCreateOptions) {
  const [pending, setPending] = useState<PendingCreate | null>(null);

  const startCreate = useCallback(
    (parentAbsPath: string, kind: EntryKind) => {
      expandIfCollapsed(workspaceId, parentAbsPath);
      setPending({ parentAbsPath, kind });
    },
    [workspaceId],
  );

  const cancel = useCallback(() => {
    setPending(null);
  }, []);

  const commit = useCallback(
    async (rawName: string): Promise<boolean> => {
      const cur = pending;
      if (!cur) return false;
      const name = rawName.trim();
      if (name.length === 0) {
        setPending(null);
        return true;
      }

      const ok =
        cur.kind === "file"
          ? await createNewFile({
              workspaceId,
              workspaceRootPath: rootAbsPath,
              parentAbsPath: cur.parentAbsPath,
              name,
            })
          : await createNewFolder({
              workspaceId,
              workspaceRootPath: rootAbsPath,
              parentAbsPath: cur.parentAbsPath,
              name,
            });

      if (ok) setPending(null);
      return ok;
    },
    [pending, workspaceId, rootAbsPath],
  );

  return { pending, startCreate, cancel, commit };
}
