/** State + transitions for an in-flight inline rename row. */

import { useCallback, useState } from "react";
import { renamePath } from "@/services/fs-mutations";
import { basename } from "@/utils/path";

interface UseFileTreePendingRenameOptions {
  workspaceId: string;
  rootAbsPath: string;
}

export interface PendingRenameState {
  absPath: string;
}

export function useFileTreePendingRename({
  workspaceId,
  rootAbsPath,
}: UseFileTreePendingRenameOptions) {
  const [pending, setPending] = useState<PendingRenameState | null>(null);

  const startRename = useCallback(
    (absPath: string) => {
      if (absPath === rootAbsPath) return;
      setPending({ absPath });
    },
    [rootAbsPath],
  );

  const cancel = useCallback(() => {
    setPending(null);
  }, []);

  const commit = useCallback(
    async (rawName: string): Promise<boolean> => {
      const cur = pending;
      if (!cur) return false;
      const name = rawName.trim();
      if (name.length === 0 || name === basename(cur.absPath)) {
        setPending(null);
        return true;
      }

      const ok = await renamePath({
        workspaceId,
        workspaceRootPath: rootAbsPath,
        absPath: cur.absPath,
        newName: name,
      });
      if (ok) setPending(null);
      return ok;
    },
    [pending, workspaceId, rootAbsPath],
  );

  return { pending, startRename, cancel, commit };
}
