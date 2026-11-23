import type { RemoteSession, RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import { type IpcResult, ipcErr } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";

export type PeerGitStatus = RpcResult<"git.status">;
export type PeerGitFile = PeerGitStatus["files"][number];
export type PeerGitSide = "staged" | "unstaged";

export function isPeerGitConflict({ staged, unstaged }: PeerGitFile): boolean {
  return (
    staged === "U" ||
    unstaged === "U" ||
    (staged === unstaged && (staged === "A" || staged === "D"))
  );
}

export const PEER_GIT_POLL_MS = 10_000;

interface WatchHost {
  document: EventTarget & Pick<Document, "visibilityState">;
  window: EventTarget;
  setInterval: (tick: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval> | undefined) => void;
}

type GitStatusResult = IpcResult<PeerGitStatus>;
const pendingByDevice = new Map<
  string,
  { workspaceId: string; request: Promise<GitStatusResult> }
>();

function startStatus(peer: PeerWorkspace): Promise<GitStatusResult> {
  const load = async (): Promise<GitStatusResult> => {
    try {
      return await ipcCallResult("remote", "peerGitStatus", peer);
    } catch {
      return ipcErr("unavailable", "");
    }
  };
  const request = load().finally(() => pendingByDevice.delete(peer.deviceId));
  pendingByDevice.set(peer.deviceId, { workspaceId: peer.workspaceId, request });
  return request;
}

export async function readPeerGitStatus(
  peer: PeerWorkspace,
  signal?: AbortSignal,
): Promise<GitStatusResult> {
  while (!signal?.aborted) {
    const pending = pendingByDevice.get(peer.deviceId);
    if (!pending) return startStatus(peer);
    if (pending.workspaceId === peer.workspaceId) return pending.request;
    await pending.request;
  }
  return ipcErr("cancelled", "");
}

export function watchPeerGitStatus(
  peer: PeerWorkspace,
  {
    gitSupported,
    onResult,
    onSessionHint,
  }: {
    gitSupported: boolean;
    onResult: (result: IpcResult<PeerGitStatus>) => void;
    onSessionHint: () => void;
  },
  host: WatchHost = {
    document,
    window,
    setInterval: (tick, delay) => setInterval(tick, delay),
    clearInterval: (timer) => clearInterval(timer),
  },
) {
  let live = true;
  let unsupported = !gitSupported;
  let timer: ReturnType<typeof setInterval> | undefined;
  let visibilityEpoch = 0;
  let waitingFor: Promise<GitStatusResult> | undefined;
  let runningTabs = new Set<string>();
  let sessionHintPending = false;

  const visible = () => live && host.document.visibilityState === "visible";

  function apply(result: GitStatusResult, epoch: number) {
    if (epoch !== visibilityEpoch || !visible()) return;
    if (!result.ok && result.kind === "unsupported") {
      unsupported = true;
      host.clearInterval(timer);
    }
    onResult(result);
  }

  function refresh(queue = true) {
    if (!visible() || unsupported) return;
    const pending = pendingByDevice.get(peer.deviceId)?.request;
    if (pending) {
      if (queue && waitingFor !== pending) {
        waitingFor = pending;
        void pending.then(() => {
          if (waitingFor !== pending) return;
          waitingFor = undefined;
          refresh();
        });
      }
      return;
    }

    const epoch = visibilityEpoch;
    void startStatus(peer).then((result) => apply(result, epoch));
  }

  function onVisibility() {
    host.clearInterval(timer);
    if (!visible()) {
      waitingFor = undefined;
      visibilityEpoch++;
      return;
    }
    if (sessionHintPending) {
      sessionHintPending = false;
      onSessionHint();
    }
    if (unsupported) return;
    refresh();
    timer = host.setInterval(() => refresh(false), PEER_GIT_POLL_MS);
  }

  function onFocus() {
    refresh(false);
  }

  host.document.addEventListener("visibilitychange", onVisibility);
  host.window.addEventListener("focus", onFocus);
  onVisibility();

  return {
    refresh: () => refresh(),
    updateSessions(sessions: readonly RemoteSession[], incomplete = false) {
      const next = new Set<string>();
      const unseen = new Set(runningTabs);
      let ended = false;
      for (const session of sessions) {
        if (session.workspaceId !== peer.workspaceId) continue;
        unseen.delete(session.tabId);
        if (session.state === "running") next.add(session.tabId);
        else if (runningTabs.has(session.tabId)) ended = true;
      }
      if (incomplete) {
        for (const tabId of unseen) next.add(tabId);
      } else if (unseen.size > 0) ended = true;
      runningTabs = next;
      if (!ended) return;
      if (!visible()) sessionHintPending = true;
      else {
        onSessionHint();
        refresh();
      }
    },
    stop() {
      live = false;
      onVisibility();
      host.document.removeEventListener("visibilitychange", onVisibility);
      host.window.removeEventListener("focus", onFocus);
    },
  };
}
