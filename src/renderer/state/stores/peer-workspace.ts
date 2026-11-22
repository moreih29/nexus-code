import { create } from "zustand";
import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { type PeerWorkspace, peerWorkspaceId } from "../../../shared/fs/peer-url";
import type { IpcResult } from "../../../shared/ipc/result";
import type { LineAt } from "../../services/chat/links";
import type {
  PeerGitFile,
  PeerGitSide,
  PeerGitStatus,
} from "../../services/remote/peer-git-status";
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

export interface PeerDiffTab extends PeerGitFile {
  type: "peer.diff";
  side: PeerGitSide;
}

export function peerTabId(tab: PeerFileTab | PeerDiffTab): string {
  return tab.type === "peer.file" ? tab.path : JSON.stringify([tab.type, tab.path, tab.side]);
}

export interface PeerFolder {
  path: string;
  entries: readonly { name: string; kind: "file" | "dir" | "link" }[];
  truncated?: boolean;
}

interface PeerWorkspaceView {
  tabs: readonly (PeerFileTab | PeerDiffTab)[];
  /** File path or the comparison tab ID. */
  activePath: string | null;
  folders: Readonly<Record<string, PeerFolder>>;
  expanded: ReadonlySet<string>;
  gitStatus?: PeerGitStatus;
  gitError?: string;
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
  openDiff: (id: string, change: PeerGitFile, side: PeerGitSide) => void;
  selectTab: (id: string, tabId: string) => void;
  closeTab: (id: string, tabId: string) => void;
  setGitResult: (id: string, result: IpcResult<PeerGitStatus>) => void;
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
        const existing = view.tabs.find(
          (tab) => tab.type === "peer.file" && peerPathKey(tab.path) === key,
        );
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
    openDiff: (id, change, side) =>
      updateView(id, (view) => {
        const tab: PeerDiffTab = { ...change, type: "peer.diff", side };
        const activePath = peerTabId(tab);
        const index = view.tabs.findIndex((item) => peerTabId(item) === activePath);
        const tabs = [...view.tabs];
        if (index < 0) tabs.push(tab);
        else tabs[index] = tab;
        return { ...view, tabs, activePath };
      }),
    selectTab: (id, tabId) =>
      updateView(id, (view) =>
        view.tabs.some((tab) => peerTabId(tab) === tabId) ? { ...view, activePath: tabId } : view,
      ),
    closeTab: (id, tabId) =>
      updateView(id, (view) => {
        const index = view.tabs.findIndex((tab) => peerTabId(tab) === tabId);
        if (index === -1) return view;
        const tabs = view.tabs.filter((_, i) => i !== index);
        const next = tabs[index] ?? tabs[index - 1];
        return {
          ...view,
          tabs,
          activePath: view.activePath === tabId ? (next ? peerTabId(next) : null) : view.activePath,
        };
      }),
    setGitResult: (id, result) =>
      updateView(id, (view) => {
        if (result.ok) return { ...view, gitStatus: result.value, gitError: undefined };
        if (view.gitError === result.kind) return view;
        const keep = result.kind === "unavailable";
        return { ...view, gitStatus: keep ? view.gitStatus : undefined, gitError: result.kind };
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
