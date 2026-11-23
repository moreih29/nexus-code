import { create } from "zustand";
import type { SessionState } from "../../../../packages/remote-protocol/src/rpc";
import { openKey, remoteSessionKey } from "../../services/agent-view/layout";
import { remoteDisplayName } from "../../services/remote/display-name";
import { requestTabFocus } from "../../services/tab-focus";
import { useAgentViewStore } from "./agent-view";

export type OpenRemoteSession = (target: RemoteTarget) => void;

export interface RemoteTarget {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
  tabId: string;
  kind: "claude" | "codex" | "terminal";
  title: string;
  state?: SessionState;
  profile?: string;
  cwd?: string;
  ask?: TerminalAsk;
}

export interface TerminalAsk {
  requestId: string;
  text: string;
  always?: boolean;
  subagent?: boolean;
}

type ListedWaiting = { text: string; requestId?: string; always?: boolean; subagent?: boolean };

export function askOf(session: {
  kind: RemoteTarget["kind"];
  waiting?: ListedWaiting;
}): TerminalAsk | undefined {
  const { waiting } = session;
  if (session.kind !== "terminal" || !waiting?.requestId) return undefined;
  return {
    requestId: waiting.requestId,
    text: waiting.text,
    ...(waiting.always !== undefined ? { always: waiting.always } : {}),
    ...(waiting.subagent !== undefined ? { subagent: waiting.subagent } : {}),
  };
}

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
    waiting?: ListedWaiting;
  }[];
}

export function refreshRemoteTarget(
  target: RemoteTarget,
  workspace?: ListedSessions["workspaces"][number],
  session?: ListedSessions["sessions"][number],
): RemoteTarget {
  const { cwd: _cwd, ask: _ask, ...rest } = target;
  const cwd = session ? session.cwd : target.cwd;
  const ask = session ? askOf(session) : target.ask;
  const updated: RemoteTarget = {
    ...rest,
    ...(cwd ? { cwd } : {}),
    ...(ask ? { ask } : {}),
    title: remoteDisplayName(session?.title ?? target.title),
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
    updated.ask?.requestId === target.ask?.requestId &&
    updated.ask?.text === target.ask?.text &&
    updated.ask?.always === target.ask?.always &&
    updated.ask?.subagent === target.ask?.subagent &&
    updated.workspaceName === target.workspaceName &&
    updated.path === target.path
  )
    return target;
  return updated;
}

export function listedRemoteTarget(
  peer: { id: string; name: string },
  workspace: ListedSessions["workspaces"][number] | undefined,
  session: ListedSessions["sessions"][number],
): RemoteTarget {
  return refreshRemoteTarget(
    {
      deviceId: peer.id,
      deviceName: remoteDisplayName(peer.name),
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceId,
      path: "",
      tabId: session.tabId,
      kind: session.kind,
      title: session.title,
    },
    workspace,
    session,
  );
}

interface RemoteViewState {
  targets: ReadonlyMap<string, RemoteTarget>;
  open(target: RemoteTarget, leafId?: string): void;
  refresh(deviceId: string, listed: ListedSessions): void;
  setProfile(key: string, profile: string): void;
}

export const useRemoteViewStore = create<RemoteViewState>((set, get) => ({
  targets: new Map(),

  open(target, leafId) {
    const key = remoteSessionKey(target);
    set({
      targets: new Map(get().targets).set(key, {
        ...target,
        deviceName: remoteDisplayName(target.deviceName),
        title: remoteDisplayName(target.title),
      }),
    });
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
      const updated = refreshRemoteTarget(target, workspace, session);
      if (updated === target) continue;
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

export function openRemoteSession(target: RemoteTarget): void {
  useRemoteViewStore.getState().open(target);
}

export function useRemoteTarget(key: string | null): RemoteTarget | undefined {
  return useRemoteViewStore((s) => (key !== null ? s.targets.get(key) : undefined));
}
