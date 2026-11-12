/** State + transitions for an in-flight inline rename row. */

import { useCallback, useEffect, useRef, useState } from "react";
import { renamePath } from "@/services/fs-mutations";
import { useFilesStore } from "@/state/stores/files";
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

  // Connects the global F2 keybinding → store bridge.
  // Calls startRename whenever pendingRenameRequest.requestId changes.
  // Thanks to the requestId indirection, the useEffect fires again even when the same absPath
  // is entered through F2 after an Esc cancel (with absPath alone as the dep, the same value
  // would not fire again).
  const lastHandledRequestId = useRef<number | null>(null);
  const pendingRenameRequest = useFilesStore((s) => s.pendingRenameRequest);
  useEffect(() => {
    if (!pendingRenameRequest) return;
    if (lastHandledRequestId.current === pendingRenameRequest.requestId) return;
    lastHandledRequestId.current = pendingRenameRequest.requestId;
    startRename(pendingRenameRequest.absPath);
  }, [pendingRenameRequest, startRename]);

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
