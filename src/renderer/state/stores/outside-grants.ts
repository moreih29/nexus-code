import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

export interface OutsideGrant {
  readonly files: readonly string[];
  readonly dirs: readonly string[];
  readonly opened?: readonly string[];
}

function isEmptyGrant(grant: OutsideGrant): boolean {
  return grant.files.length === 0 && grant.dirs.length === 0 && (grant.opened ?? []).length === 0;
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
        if (isEmptyGrant(grant)) delete owners[owner];
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
  if (!a) return isEmptyGrant(b);
  return same(a.files, b.files) && same(a.dirs, b.dirs) && same(a.opened ?? [], b.opened ?? []);
}

export function grantOutside(workspaceId: string, owner: string, grant: OutsideGrant): void {
  const key = `${workspaceId}\0${owner}`;
  if (sameGrant(sent.get(key), grant)) return;
  sent.set(key, grant);
  const revoke = isEmptyGrant(grant);
  if (revoke) useOutsideGrantsStore.getState().set(workspaceId, owner, grant);
  ipcCallResult("fs", "grantOutside", {
    workspaceId,
    owner,
    files: [...grant.files],
    dirs: [...grant.dirs],
    opened: [...(grant.opened ?? [])],
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
    if (grant.files.includes(absPath) || grant.opened?.includes(absPath)) return true;
    if (grant.dirs.some((dir) => absPath.startsWith(`${dir}/`))) return true;
  }
  return false;
}

export function useOutsideGranted(workspaceId: string, absPath: string): boolean {
  return useOutsideGrantsStore((s) => isOutsideGranted(s.byWorkspace, workspaceId, absPath));
}
