import { useCallback, useState } from "react";
import { createNewFile, createNewFolder } from "@/services/fs-mutations";
import { toggleExpand } from "@/state/operations/files";
import { useFilesStore } from "@/state/stores/files";
import type { EntryKind, PendingCreate } from "../file-tree/display";

interface UseFileTreePendingCreateOptions {
  workspaceId: string;
  rootAbsPath: string;
}

function expandIfCollapsed(workspaceId: string, parentAbsPath: string): void {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;
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
