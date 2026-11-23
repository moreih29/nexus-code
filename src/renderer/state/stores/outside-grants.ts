import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

export interface OutsideGrant {
  readonly files: readonly string[];
  readonly dirs: readonly string[];
}

interface OutsideGrantsStore {
  byWorkspace: Record<string, Record<string, OutsideGrant>>;
  set(workspaceId: string, owner: string, grant: OutsideGrant): void;
  clearWorkspace(workspaceId: string): void;
}

const sent = new Map<string, OutsideGrant>();

export const useOutsideGrantsStore = create<OutsideGrantsStore>((set, get) => {
  registerWorkspaceCleanup((workspaceId) => {
    get().clearWorkspace(workspaceId);
    for (const key of sent.keys()) {
      if (key.startsWith(`${workspaceId}\0`)) sent.delete(key);
    }
  });

  return {
    byWorkspace: {},

    set(workspaceId, owner, grant) {
      set((state) => {
        const owners = { ...state.byWorkspace[workspaceId] };
        if (grant.files.length === 0 && grant.dirs.length === 0) delete owners[owner];
        else owners[owner] = grant;
        return { byWorkspace: { ...state.byWorkspace, [workspaceId]: owners } };
      });
    },

    clearWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const { [workspaceId]: _gone, ...rest } = state.byWorkspace;
        return { byWorkspace: rest };
      });
    },
  };
});

function sameGrant(a: OutsideGrant | undefined, b: OutsideGrant): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  if (!a) return b.files.length === 0 && b.dirs.length === 0;
  return same(a.files, b.files) && same(a.dirs, b.dirs);
}

export function grantOutside(workspaceId: string, owner: string, grant: OutsideGrant): void {
  const key = `${workspaceId}\0${owner}`;
  if (sameGrant(sent.get(key), grant)) return;
  sent.set(key, grant);
  const revoke = grant.files.length === 0 && grant.dirs.length === 0;
  if (revoke) useOutsideGrantsStore.getState().set(workspaceId, owner, grant);
  ipcCallResult("fs", "grantOutside", {
    workspaceId,
    owner,
    files: [...grant.files],
    dirs: [...grant.dirs],
  })
    .then((result) => {
      if (!result.ok || revoke || sent.get(key) !== grant) return;
      useOutsideGrantsStore.getState().set(workspaceId, owner, grant);
    })
    .catch(() => {});
}

export function isOutsideGranted(
  byWorkspace: OutsideGrantsStore["byWorkspace"],
  workspaceId: string,
  absPath: string,
): boolean {
  for (const grant of Object.values(byWorkspace[workspaceId] ?? {})) {
    if (grant.files.includes(absPath)) return true;
    if (grant.dirs.some((dir) => absPath.startsWith(`${dir}/`))) return true;
  }
  return false;
}

export function useOutsideGranted(workspaceId: string, absPath: string): boolean {
  return useOutsideGrantsStore((s) => isOutsideGranted(s.byWorkspace, workspaceId, absPath));
}

export function useOutsideDirGranted(workspaceId: string, absDir: string): boolean {
  return useOutsideGrantsStore((s) =>
    Object.values(s.byWorkspace[workspaceId] ?? {}).some((grant) =>
      grant.dirs.some((dir) => absDir === dir || absDir.startsWith(`${dir}/`)),
    ),
  );
}
