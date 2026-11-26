import { createContext, useContext, useEffect, useState } from "react";
import { ipcCallResult, ipcListen } from "../../../ipc/client";
import { fileSignal } from "../../../services/editor/preview/file-refresh";
import { peerOf, usePeerFileRevision } from "../../../services/remote/peer-workspace";
import { usePreviewDraft } from "./preview-draft";

export const PeerPreviewVersion = createContext<number | null>(null);

export function useFileVersion(workspaceId: string, relPath: string): number {
  const draft = usePreviewDraft();
  const local = useLocalFileVersion(workspaceId, relPath, draft === null);
  const supplied = useContext(PeerPreviewVersion);
  const remote = usePeerFileRevision(workspaceId, relPath, draft === null && supplied === null);
  return draft ? 0 : fileSignal(peerOf(workspaceId) !== null, local, supplied ?? remote);
}

function useLocalFileVersion(workspaceId: string, relPath: string, enabled: boolean): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled || peerOf(workspaceId)) return;
    let cancelled = false;
    let statKey: string | null | undefined;
    const refresh = (force: boolean) => {
      void ipcCallResult("fs", "stat", { workspaceId, relPath }).then((result) => {
        if (cancelled) return;
        const key = result.ok ? `${result.value.mtime}|${result.value.size}` : null;
        const hadBaseline = statKey !== undefined;
        const changed = key !== statKey;
        statKey = key;
        if (hadBaseline && (force || changed)) setVersion((v) => v + 1);
      });
    };
    refresh(false);
    const unsubscribeFs = ipcListen("fs", "changed", (event) => {
      if (event.workspaceId !== workspaceId) return;
      if (!event.changes.some((change) => change.relPath === relPath)) return;
      refresh(true);
    });
    const unsubscribeGit = ipcListen("git", "statusChanged", (event) => {
      if (event.workspaceId !== workspaceId) return;
      refresh(false);
    });
    return () => {
      cancelled = true;
      unsubscribeFs();
      unsubscribeGit();
    };
  }, [workspaceId, relPath, enabled]);

  return version;
}

export function versionedUrl(url: string, version: number, epoch?: number): string {
  if (epoch !== undefined) return `${url}?v=${version}&epoch=${epoch}`;
  return version === 0 ? url : `${url}?v=${version}`;
}
