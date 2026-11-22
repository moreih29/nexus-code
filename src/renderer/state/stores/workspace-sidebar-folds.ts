import { create } from "zustand";
import { WORKSPACE_SIDEBAR_FOLDED_PEERS_MAX } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";

interface WorkspaceSidebarFolds {
  foldedPeers: readonly string[];
  hydrate: (peers: readonly string[]) => void;
  togglePeer: (id: string) => void;
}

export const useWorkspaceSidebarFolds = create<WorkspaceSidebarFolds>((set, get) => ({
  foldedPeers: [],
  hydrate: (peers) => set({ foldedPeers: [...new Set(peers)] }),
  togglePeer: (id) => {
    const before = get().foldedPeers;
    const foldedPeers = before.includes(id)
      ? before.filter((peer) => peer !== id)
      : [...before, id].slice(-WORKSPACE_SIDEBAR_FOLDED_PEERS_MAX);
    set({ foldedPeers });
    void ipcCallResult("appState", "set", { workspaceSidebarFoldedPeers: foldedPeers });
  },
}));
