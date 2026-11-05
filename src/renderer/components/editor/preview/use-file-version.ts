// Which version of a workspace file a viewer that loads it by URL shows.
//
// The `nexus-workspace://` URL is stable for a given file, so an on-disk
// change would never re-request it. The version starts at 0 and goes up
// whenever the file changes: on fs.changed for it, and on git.statusChanged
// when a stat shows it moved (for directories the file-tree watcher doesn't
// cover). A viewer appends it to the URL as `?v=<n>`, which main ignores.

import { useEffect, useState } from "react";
import { ipcCallResult, ipcListen } from "../../../ipc/client";

export function useFileVersion(workspaceId: string, relPath: string): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // `${mtime}|${size}` last observed; null = missing, undefined = no
    // baseline yet (the first stat only records, never bumps).
    let statKey: string | null | undefined;
    // fs.changed already proves a write happened, so it forces a bump even
    // when the stat compares equal (mtime is only ms-granular).
    // git.statusChanged fires for any workspace change, so it bumps only
    // when this file's stat actually moved.
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
  }, [workspaceId, relPath]);

  return version;
}

/** `url` for `version` of its file: the first as it is, later ones marked. */
export function versionedUrl(url: string, version: number): string {
  return version === 0 ? url : `${url}?v=${version}`;
}
