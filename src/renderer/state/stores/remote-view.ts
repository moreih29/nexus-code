/**
 * The sessions of other computers the agent view's panels hold as tabs,
 * opened from its list's Other computers: what each tab shows of its
 * session, by the key the panel holds it by (remoteSessionKey). Not kept:
 * the other computer may be gone when the app starts again, and the panels
 * let go of these keys then.
 */

import { create } from "zustand";
import type { SessionState } from "../../../../packages/remote-protocol/src/rpc";
import { openKey, remoteSessionKey } from "../../services/agent-view/layout";
import { requestTabFocus } from "../../services/tab-focus";
import { useAgentViewStore } from "./agent-view";

/** A session of another computer, with the names to tell it by. */
export interface RemoteTarget {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspaceName: string;
  /** The workspace's folder on that computer. */
  path: string;
  tabId: string;
  kind: "claude" | "codex" | "terminal";
  title: string;
  /** How it stood when its computer last listed it. */
  state?: SessionState;
  /** The agent profile a chat runs with, by name, as its computer last listed it. */
  profile?: string;
  /** The folder a chat runs in, when it is not its workspace's: its links are written from there. */
  cwd?: string;
}

/** What the computer's list says of its sessions now, for the tabs to show. */
export interface ListedSessions {
  workspaces: readonly { id: string; name: string; path: string }[];
  sessions: readonly {
    workspaceId: string;
    tabId: string;
    kind: RemoteTarget["kind"];
    title: string;
    state: SessionState;
    profile?: string;
    cwd?: string;
  }[];
}

interface RemoteViewState {
  targets: ReadonlyMap<string, RemoteTarget>;
  /**
   * Shows a session as a tab of the agent view: in front of the panel
   * holding it, else added to `leafId` (the active panel by default), with
   * the keyboard, as a chat of this computer's opens.
   */
  open(target: RemoteTarget, leafId?: string): void;
  /** Takes up a computer's newer names and titles for the tabs of its sessions. */
  refresh(deviceId: string, listed: ListedSessions): void;
  /** A chat now runs with another profile, by name, as chat.profile answered. */
  setProfile(key: string, profile: string): void;
}

export const useRemoteViewStore = create<RemoteViewState>((set, get) => ({
  targets: new Map(),

  open(target, leafId) {
    const key = remoteSessionKey(target);
    set({ targets: new Map(get().targets).set(key, target) });
    const view = useAgentViewStore.getState();
    view.setMode("agents");
    view.update((layout) => openKey(layout, key, leafId));
    requestTabFocus(key);
  },

  refresh(deviceId, listed) {
    let next: Map<string, RemoteTarget> | null = null;
    for (const [key, target] of get().targets) {
      if (target.deviceId !== deviceId) continue;
      const session = listed.sessions.find(
        (s) => s.workspaceId === target.workspaceId && s.tabId === target.tabId,
      );
      const workspace = listed.workspaces.find((w) => w.id === target.workspaceId);
      const { cwd: _cwd, ...rest } = target;
      // A chat listed tells its folder, or none for its workspace's.
      const cwd = session ? session.cwd : target.cwd;
      const updated: RemoteTarget = {
        ...rest,
        ...(cwd ? { cwd } : {}),
        title: session?.title ?? target.title,
        kind: session?.kind ?? target.kind,
        state: session?.state ?? target.state,
        ...((session?.profile ?? target.profile)
          ? { profile: session?.profile ?? target.profile }
          : {}),
        workspaceName: workspace?.name ?? target.workspaceName,
        path: workspace?.path || target.path,
      };
      if (
        updated.title === target.title &&
        updated.kind === target.kind &&
        updated.state === target.state &&
        updated.profile === target.profile &&
        updated.cwd === target.cwd &&
        updated.workspaceName === target.workspaceName &&
        updated.path === target.path
      ) {
        continue;
      }
      next ??= new Map(get().targets);
      next.set(key, updated);
    }
    if (next) set({ targets: next });
  },

  setProfile(key, profile) {
    const target = get().targets.get(key);
    if (!target || target.profile === profile) return;
    set({ targets: new Map(get().targets).set(key, { ...target, profile }) });
  },
}));

/** The tab's session a key names; undefined for one this run of the app did not open. */
export function useRemoteTarget(key: string | null): RemoteTarget | undefined {
  return useRemoteViewStore((s) => (key !== null ? s.targets.get(key) : undefined));
}
