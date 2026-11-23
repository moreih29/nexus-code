import { useEffect, useRef, useState } from "react";
import { appErrorFailed } from "../../../shared/error/app-error";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { WorkspaceColor } from "../../../shared/types/workspace-color";
import { useIpcAction } from "../../hooks/use-ipc-action";
import { ipcCallResult } from "../../ipc/client";
import { surfaceError } from "../../services/error-surface/surface-error";

export function resolveRename(draft: string, current: string): string | null {
  const name = draft.trim();
  return name === "" || name === current ? null : name;
}

export function useWorkspaceUpdate(ws: WorkspaceMeta) {
  const { run } = useIpcAction<WorkspaceMeta>({});
  return (patch: { name?: string; color?: WorkspaceColor; pinned?: boolean }) => {
    run(async (signal) => {
      const result = await ipcCallResult(
        "workspace",
        "update",
        { id: ws.id, ...patch },
        { signal },
      );
      if (!result.ok) {
        const err = appErrorFailed(result.message);
        surfaceError(err, { surface: "auto" });
        throw err;
      }
      return result.value;
    });
  };
}

export function useWorkspaceRename(ws: WorkspaceMeta, update: (patch: { name: string }) => void) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settled = useRef(true);
  function start() {
    settled.current = false;
    setDraft(ws.name);
    setRenaming(true);
  }
  function end(commit: boolean) {
    if (settled.current) return;
    settled.current = true;
    setRenaming(false);
    const name = commit ? resolveRename(draft, ws.name) : null;
    if (name !== null) update({ name });
  }
  useEffect(() => {
    if (!renaming) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [renaming]);
  return { renaming, draft, setDraft, inputRef, start, end };
}
