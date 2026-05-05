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
import { useFilesStore } from "@/state/stores/files";
import type { EntryKind, PendingCreate } from "./file-tree-display";

interface UseFileTreePendingCreateOptions {
  workspaceId: string;
  rootAbsPath: string;
}

export function useFileTreePendingCreate({
  workspaceId,
  rootAbsPath,
}: UseFileTreePendingCreateOptions) {
  const [pending, setPending] = useState<PendingCreate | null>(null);

  const startCreate = useCallback(
    (parentAbsPath: string, kind: EntryKind) => {
      // Ensure the parent is expanded so the input row is visible.
      const tree = useFilesStore.getState().trees.get(workspaceId);
      if (tree && parentAbsPath !== tree.rootAbsPath && !tree.expanded.has(parentAbsPath)) {
        useFilesStore.getState().toggleExpand(workspaceId, parentAbsPath);
      }
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
