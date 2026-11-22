import { create } from "zustand";
import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { type PeerWorkspace, peerWorkspaceId } from "../../../shared/fs/peer-url";
import type { LineAt } from "../../services/chat/links";
import { peerPathKey } from "../../utils/peer-path";

export interface PeerWorkspaceTarget extends PeerWorkspace {
  accountKey: string;
  deviceName: string;
  platform: string;
  workspace: RemoteWorkspace;
}

export interface PeerFileTab {
  type: "peer.file";
  path: string;
  at?: LineAt;
}

export interface PeerFolder {
  path: string;
  entries: readonly { name: string; kind: "file" | "dir" | "link" }[];
  truncated?: boolean;
}

interface PeerWorkspaceView {
  tabs: readonly PeerFileTab[];
  activePath: string | null;
  folders: Readonly<Record<string, PeerFolder>>;
  expanded: ReadonlySet<string>;
}

export const EMPTY_PEER_VIEW: PeerWorkspaceView = {
  tabs: [],
  activePath: null,
  folders: {},
  expanded: new Set(),
};

export function peerTargetId({ deviceId, workspaceId }: PeerWorkspace): string {
  return peerWorkspaceId(deviceId, workspaceId);
}

interface PeerWorkspaceState {
  active: PeerWorkspaceTarget | null;
  lastLocalId: string | null;
  missing: boolean;
  accountKey: string | null;
  views: Readonly<Record<string, PeerWorkspaceView>>;
  select: (target: PeerWorkspaceTarget, localId: string | null) => void;
  updateTarget: (target: PeerWorkspaceTarget) => void;
  markMissing: (id: string) => void;
  clearSelection: () => void;
  setAccount: (key: string | null) => void;
  openFile: (id: string, path: string, at?: LineAt) => void;
  closeFile: (id: string, path: string) => void;
  setFolder: (id: string, key: string, folder: PeerFolder | null) => void;
  toggleFolder: (id: string, path: string) => void;
}

export const usePeerWorkspaceStore = create<PeerWorkspaceState>((set, get) => {
  function updateView(id: string, update: (view: PeerWorkspaceView) => PeerWorkspaceView) {
    const state = get();
    if (!state.active || peerTargetId(state.active) !== id || state.missing) return;
    const previous = state.views[id] ?? EMPTY_PEER_VIEW;
    const view = update(previous);
    if (view !== previous) set({ views: { ...state.views, [id]: view } });
  }

  return {
    active: null,
    lastLocalId: null,
    missing: false,
    accountKey: null,
    views: {},
    select: (active, localId) =>
      set((state) => ({
        active,
        lastLocalId: state.active ? state.lastLocalId : localId,
        missing: false,
        accountKey: active.accountKey,
        views: state.accountKey === active.accountKey ? state.views : {},
      })),
    updateTarget: (active) =>
      set((state) =>
        state.active?.accountKey === active.accountKey &&
        peerTargetId(state.active) === peerTargetId(active)
          ? { active }
          : state,
      ),
    markMissing: (id) =>
      set((state) => {
        if (!state.active || peerTargetId(state.active) !== id || state.missing) return state;
        const views = { ...state.views };
        delete views[id];
        return { missing: true, views };
      }),
    clearSelection: () => set({ active: null, lastLocalId: null, missing: false }),
    setAccount: (accountKey) =>
      set((state) => (state.accountKey === accountKey ? state : { accountKey, views: {} })),
    openFile: (id, path, at) =>
      updateView(id, (view) => {
        const key = peerPathKey(path);
        const existing = view.tabs.find((tab) => peerPathKey(tab.path) === key);
        if (!existing) {
          const tab: PeerFileTab = { type: "peer.file", path, ...(at && { at }) };
          return { ...view, tabs: [...view.tabs, tab], activePath: path };
        }
        return {
          ...view,
          tabs: at ? view.tabs.map((tab) => (tab === existing ? { ...tab, at } : tab)) : view.tabs,
          activePath: existing.path,
        };
      }),
    closeFile: (id, path) =>
      updateView(id, (view) => {
        const index = view.tabs.findIndex((tab) => tab.path === path);
        if (index === -1) return view;
        const tabs = view.tabs.filter((tab) => tab.path !== path);
        return {
          ...view,
          tabs,
          activePath:
            view.activePath === path
              ? (tabs[index]?.path ?? tabs[index - 1]?.path ?? null)
              : view.activePath,
        };
      }),
    setFolder: (id, key, folder) =>
      updateView(id, (view) => {
        const folders = { ...view.folders };
        if (folder) folders[key] = folder;
        else delete folders[key];
        return { ...view, folders };
      }),
    toggleFolder: (id, path) =>
      updateView(id, (view) => {
        const expanded = new Set(view.expanded);
        if (expanded.has(path)) expanded.delete(path);
        else expanded.add(path);
        return { ...view, expanded };
      }),
  };
});
