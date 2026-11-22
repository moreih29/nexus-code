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

// A workspace switch can end one watch while its last request is settling.
const pendingByDevice = new Map<string, Promise<void>>();

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
  let waitingFor: Promise<void> | undefined;
  let runningTabs = new Set<string>();
  let sessionHintPending = false;

  const visible = () => live && host.document.visibilityState === "visible";

  async function read(epoch: number) {
    let result: IpcResult<PeerGitStatus>;
    try {
      result = await ipcCallResult("remote", "peerGitStatus", peer);
    } catch {
      result = ipcErr("unavailable", "");
    }
    if (epoch !== visibilityEpoch || !visible()) return;
    if (!result.ok && result.kind === "unsupported") {
      unsupported = true;
      host.clearInterval(timer);
    }
    onResult(result);
  }

  function refresh(queue = true) {
    if (!visible() || unsupported) return;
    const pending = pendingByDevice.get(peer.deviceId);
    if (pending) {
      // A manual or session-triggered read may be newer than the pending result.
      // Coalesce those triggers into one follow-up. A tick never queues work.
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

    const done = read(visibilityEpoch).finally(() => {
      pendingByDevice.delete(peer.deviceId);
    });
    pendingByDevice.set(peer.deviceId, done);
  }

  function onVisibility() {
    host.clearInterval(timer);
    if (!visible()) {
      waitingFor = undefined;
      // Keep the device slot until its request settles. Cancelling the local
      // wait would not stop the host from running Git.
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
    updateSessions(sessions: readonly RemoteSession[]) {
      const next = new Set<string>();
      let ended = false;
      for (const session of sessions) {
        if (session.workspaceId !== peer.workspaceId) continue;
        if (session.state === "running") next.add(session.tabId);
        else if (runningTabs.has(session.tabId)) ended = true;
      }
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
