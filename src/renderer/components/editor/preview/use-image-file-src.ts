import { useEffect, useState } from "react";
import { ipcCallResult, ipcListen } from "../../../ipc/client";
import { usePeerImageVersion } from "../../../services/remote/peer-file-live";
import { peerOf } from "../../../services/remote/peer-workspace";
import { usePreviewDraft } from "./preview-draft";

const localReads = new Map<string, ReturnType<typeof watchLocalImage>>();

function watchLocalImage(workspaceId: string, relPath: string) {
  const listeners = new Set<(version: string) => void>();
  let pending = false;
  let again = false;
  const publish = (version: string) => {
    for (const listener of listeners) listener(version);
  };
  const refresh = (changed = false) => {
    if (pending) {
      again ||= changed;
      return;
    }
    pending = true;
    void ipcCallResult("fs", "readRange", { workspaceId, relPath, offset: 0, length: 0 })
      .then((result) => {
        const file = result.ok ? result.value : null;
        publish(file?.kind === "ok" ? (file.version ?? `${file.mtime}|${file.sizeBytes}`) : "");
      })
      .catch(() => publish(""))
      .finally(() => {
        pending = false;
        if (again && listeners.size) {
          again = false;
          refresh();
        }
      });
  };
  const onFocus = () => refresh();
  const offFs = ipcListen("fs", "changed", (event) => {
    if (
      event.workspaceId === workspaceId &&
      event.changes.some((change) => change.relPath === relPath)
    ) {
      refresh(true);
    }
  });
  const offGit = ipcListen("git", "statusChanged", (event) => {
    if (event.workspaceId === workspaceId) refresh();
  });
  window.addEventListener("focus", onFocus);
  return {
    listeners,
    refresh,
    stop() {
      offFs();
      offGit();
      window.removeEventListener("focus", onFocus);
    },
  };
}

function useLocalImageVersion(workspaceId: string, relPath: string, enabled: boolean) {
  const key = JSON.stringify([workspaceId, relPath]);
  const [shown, setShown] = useState<{ key: string; version: string }>();
  useEffect(() => {
    if (!enabled) return;
    const entry = localReads.get(key) ?? watchLocalImage(workspaceId, relPath);
    localReads.set(key, entry);
    const show = (version: string) =>
      setShown((was) => (was?.key === key && was.version === version ? was : { key, version }));
    entry.listeners.add(show);
    entry.refresh();
    return () => {
      entry.listeners.delete(show);
      if (!entry.listeners.size) {
        entry.stop();
        localReads.delete(key);
      }
    };
  }, [key, workspaceId, relPath, enabled]);
  return enabled && shown?.key === key ? shown.version : undefined;
}

export function useImageFileSrc(
  workspaceId: string,
  relPath: string,
  url: string | null,
  options?: { watch: boolean; connection: number },
): string | undefined {
  const peer = peerOf(workspaceId) !== null;
  const draft = usePreviewDraft();
  const enabled = !draft && url !== null;
  const local = useLocalImageVersion(workspaceId, relPath, enabled && !peer);
  const remote = usePeerImageVersion(
    workspaceId,
    relPath,
    enabled && peer && (options?.watch ?? true),
    options?.connection ?? 0,
  );
  if (!url) return undefined;
  if (draft) return url;
  const version = peer ? remote : local;
  if (version === undefined) return undefined;
  return `${url}?v=${encodeURIComponent(version)}`;
}
