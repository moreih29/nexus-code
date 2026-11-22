import { create } from "zustand";
import type { RemoteSession, RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { type PeerWorkspace, peerWorkspaceId } from "../../../shared/fs/peer-url";
import type { IpcResult } from "../../../shared/ipc/result";
import type { LineAt } from "../../services/chat/links";
import type {
  PeerGitFile,
  PeerGitSide,
  PeerGitStatus,
} from "../../services/remote/peer-git-status";
import { peerPathKey } from "../../utils/peer-path";
import { listedRemoteTarget, type RemoteTarget, refreshRemoteTarget } from "./remote-view";

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

export interface PeerCommitTab {
  type: "peer.commit";
  hash: string;
  subject: string;
}

export interface PeerSessionTab {
  type: "peer.session";
  target: RemoteTarget;
  gone?: true;
  /** Opened by a control reply and awaiting its first listing. */
  pending?: true;
}

type PeerWorkspaceTab = PeerFileTab | PeerDiffTab | PeerCommitTab | PeerSessionTab;

export function peerTabId(tab: PeerWorkspaceTab): string {
  switch (tab.type) {
    case "peer.file":
      return tab.path;
    case "peer.diff":
      return JSON.stringify([tab.type, tab.path, tab.side]);
    case "peer.commit":
      return JSON.stringify([tab.type, tab.hash]);
    case "peer.session":
      return JSON.stringify([tab.type, tab.target.tabId]);
  }
}

export interface PeerFolder {
  path: string;
  entries: readonly { name: string; kind: "file" | "dir" | "link" }[];
  truncated?: boolean;
}

interface PeerWorkspaceView {
  tabs: readonly PeerWorkspaceTab[];
  /** File path or structured tab ID. */
  activePath: string | null;
  sessions: readonly RemoteSession[];
  hiddenSessions: ReadonlySet<string>;
  folders: Readonly<Record<string, PeerFolder>>;
  expanded: ReadonlySet<string>;
  gitStatus?: PeerGitStatus;
  gitError?: string;
}

export const EMPTY_PEER_VIEW: PeerWorkspaceView = {
  tabs: [],
  activePath: null,
  sessions: [],
  hiddenSessions: new Set(),
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
  openCommit: (id: string, commit: Pick<PeerCommitTab, "hash" | "subject">) => void;
  openSession: (id: string, target: RemoteTarget) => void;
  syncSessions: (
    target: PeerWorkspaceTarget,
    sessions: readonly RemoteSession[],
    incomplete: boolean,
  ) => void;
  markSessionGone: (id: string, tabId: string) => void;
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

  function openTab(id: string, tab: PeerDiffTab | PeerCommitTab | PeerSessionTab) {
    updateView(id, (view) => {
      const activePath = peerTabId(tab);
      const index = view.tabs.findIndex((item) => peerTabId(item) === activePath);
      const tabs = [...view.tabs];
      const previous = tabs[index];
      let hiddenSessions = view.hiddenSessions;
      if (tab.type === "peer.session") {
        const { tabId } = tab.target;
        if (previous?.type === "peer.session" && !previous.gone) tab = previous;
        else if (!view.sessions.some((session) => session.tabId === tabId)) {
          tab = { ...tab, pending: true };
        }
        if (hiddenSessions.has(tabId)) {
          hiddenSessions = new Set([...hiddenSessions].filter((id) => id !== tabId));
        }
      }
      if (index < 0) tabs.push(tab);
      else tabs[index] = tab;
      return { ...view, tabs, activePath, hiddenSessions };
    });
  }

  return {
    active: null,
    lastLocalId: null,
    missing: false,
    accountKey: null,
    views: {},
    select: (active, localId) =>
      set((state) => {
        const id = peerTargetId(active);
        let views = state.accountKey === active.accountKey ? state.views : {};
        const view = views[id];
        if (view) {
          const tabs = view.tabs.filter((tab) => tab.type !== "peer.session" || !tab.gone);
          if (tabs.length !== view.tabs.length) {
            const activePath = tabs.some((tab) => peerTabId(tab) === view.activePath)
              ? view.activePath
              : tabs[0]
                ? peerTabId(tabs[0])
                : null;
            views = { ...views, [id]: { ...view, tabs, activePath } };
          }
        }
        return {
          active,
          lastLocalId: state.active ? state.lastLocalId : localId,
          missing: false,
          accountKey: active.accountKey,
          views,
        };
      }),
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
          (tab): tab is PeerFileTab => tab.type === "peer.file" && peerPathKey(tab.path) === key,
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
    openDiff: (id, change, side) => openTab(id, { ...change, type: "peer.diff", side }),
    openCommit: (id, { hash, subject }) => openTab(id, { type: "peer.commit", hash, subject }),
    openSession: (id, target) => {
      if (peerTargetId(target) === id) openTab(id, { type: "peer.session", target });
    },
    syncSessions: (target, listed, incomplete) => {
      if (get().active?.accountKey !== target.accountKey) return;
      updateView(peerTargetId(target), (view) => {
        const { deviceId, deviceName, workspace, workspaceId } = target;
        const sessions = listed.filter((session) => session.workspaceId === workspaceId);
        const byTab = new Map(sessions.map((session) => [session.tabId, session]));
        const existing = new Set<string>();
        const tabs = view.tabs.map((tab) => {
          if (tab.type !== "peer.session") return tab;
          existing.add(tab.target.tabId);
          const session = byTab.get(tab.target.tabId);
          const named =
            tab.target.deviceName === deviceName ? tab.target : { ...tab.target, deviceName };
          const updated = refreshRemoteTarget(named, workspace, session);
          if (!session) {
            if (incomplete || tab.pending || tab.gone) {
              return updated === tab.target ? tab : { ...tab, target: updated };
            }
            return { ...tab, target: updated, gone: true as const };
          }
          if (updated === tab.target && !tab.gone && !tab.pending) return tab;
          return { type: "peer.session" as const, target: updated };
        });
        for (const session of sessions) {
          if (existing.has(session.tabId) || view.hiddenSessions.has(session.tabId)) continue;
          tabs.push({
            type: "peer.session",
            target: listedRemoteTarget({ id: deviceId, name: deviceName }, workspace, session),
          });
        }
        if (incomplete) {
          sessions.push(...view.sessions.filter((session) => !byTab.has(session.tabId)));
        }
        return {
          ...view,
          tabs,
          sessions,
          activePath: view.activePath ?? (tabs[0] ? peerTabId(tabs[0]) : null),
        };
      });
    },
    markSessionGone: (id, tabId) =>
      updateView(id, (view) => {
        const tab = view.tabs.find(
          (tab) => tab.type === "peer.session" && tab.target.tabId === tabId && !tab.gone,
        );
        if (tab?.type !== "peer.session") return view;
        return {
          ...view,
          tabs: view.tabs.map((current) =>
            current === tab ? { type: tab.type, target: tab.target, gone: true } : current,
          ),
          sessions: view.sessions.filter((session) => session.tabId !== tabId),
        };
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
        const closed = view.tabs[index];
        return {
          ...view,
          tabs,
          hiddenSessions:
            closed?.type === "peer.session"
              ? new Set([...view.hiddenSessions, closed.target.tabId])
              : view.hiddenSessions,
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
