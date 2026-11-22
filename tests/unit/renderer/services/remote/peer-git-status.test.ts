import { expect, mock, spyOn, test } from "bun:test";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  PEER_GIT_POLL_MS,
  type PeerGitStatus,
  watchPeerGitStatus,
} from "../../../../../src/renderer/services/remote/peer-git-status";
import { type IpcResult, ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const peer = { deviceId: "device", workspaceId: "workspace" };
const status = { branch: "main", ahead: 0, behind: 0, files: [] };
const ready = ipcOk(status);

function desktop() {
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const window = new EventTarget();
  let schedule = 0;
  const timers = new Map<number, () => void>();
  return {
    document,
    window,
    setInterval(tick: () => void, delay: number) {
      expect(delay).toBe(PEER_GIT_POLL_MS);
      timers.set(++schedule, tick);
      return schedule as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer: ReturnType<typeof setInterval> | undefined) {
      if (timer !== undefined) timers.delete(timer as unknown as number);
    },
    tick() {
      for (const tick of timers.values()) tick();
    },
    show(visibilityState: DocumentVisibilityState) {
      document.visibilityState = visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    focus: () => window.dispatchEvent(new Event("focus")),
  };
}

function callbacks() {
  return {
    onResult: mock((_reply: IpcResult<PeerGitStatus>) => {}),
    onSessionHint: mock(() => {}),
    gitSupported: true,
  };
}

test("Git status polls every 10 seconds when shown and refreshes on focus and on demand", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ready);
  const host = desktop();
  const handlers = callbacks();
  const watch = watchPeerGitStatus(peer, handlers, host);
  try {
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0].slice(0, 3)).toEqual(["remote", "peerGitStatus", peer]);
    await Bun.sleep(0);
    host.tick();
    await Bun.sleep(0);
    host.focus();
    await Bun.sleep(0);
    watch.refresh();
    await Bun.sleep(0);
    expect(handlers.onResult).toHaveBeenCalledTimes(4);

    host.show("hidden");
    host.tick();
    host.focus();
    watch.refresh();
    expect(call).toHaveBeenCalledTimes(4);

    host.show("visible");
    expect(call).toHaveBeenCalledTimes(5);
    await Bun.sleep(0);
    watch.stop(); // Going offline or leaving the peer workspace releases the watch.
    host.focus();
    host.tick();
    host.show("visible");
    watch.refresh();
    expect(call).toHaveBeenCalledTimes(5);
  } finally {
    watch.stop();
    call.mockRestore();
  }
});

test("Git status serializes device requests and coalesces refreshes", async () => {
  const firstResponse = Promise.withResolvers<IpcResult<PeerGitStatus>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => firstResponse.promise)
    .mockResolvedValue(ready);
  const host = desktop();
  const first = callbacks();
  const watch = watchPeerGitStatus(peer, first, host);
  const second = callbacks();
  try {
    host.tick();
    watch.refresh();
    watch.refresh();
    expect(call).toHaveBeenCalledTimes(1);
    watch.stop();

    const nextPeer = { ...peer, workspaceId: "second" };
    const next = watchPeerGitStatus(nextPeer, second, host);
    try {
      expect(call).toHaveBeenCalledTimes(1);
      next.refresh();
      firstResponse.resolve(ready);
      await Bun.sleep(0);
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[1].slice(0, 3)).toEqual(["remote", "peerGitStatus", nextPeer]);
      expect(first.onResult).not.toHaveBeenCalled();
      expect(second.onResult).toHaveBeenCalledTimes(1);
    } finally {
      next.stop();
    }
  } finally {
    watch.stop();
    call.mockRestore();
  }
});

test("hiding a window discards a late result and keeps the device slot until it settles", async () => {
  const firstResponse = Promise.withResolvers<IpcResult<PeerGitStatus>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => firstResponse.promise)
    .mockResolvedValue(ready);
  const host = desktop();
  const handlers = callbacks();
  const watch = watchPeerGitStatus(peer, handlers, host);
  try {
    host.show("hidden");
    host.show("visible");
    watch.refresh();
    expect(call).toHaveBeenCalledTimes(1);
    firstResponse.resolve(ipcOk({ ...status, branch: "stale" }));
    await Bun.sleep(0);
    expect(call).toHaveBeenCalledTimes(2);
    expect(handlers.onResult.mock.calls).toEqual([[ready]]);
  } finally {
    watch.stop();
    call.mockRestore();
  }
});

test("a session ending in the selected workspace refreshes Git and signals the tree", async () => {
  const firstResponse = Promise.withResolvers<IpcResult<PeerGitStatus>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => firstResponse.promise)
    .mockResolvedValue(ready);
  const host = desktop();
  const handlers = callbacks();
  const watch = watchPeerGitStatus(peer, handlers, host);
  const here: RemoteSession = {
    workspaceId: peer.workspaceId,
    tabId: "here",
    kind: "codex",
    title: "Here",
    state: "running",
  };
  const other = { ...here, workspaceId: "other", tabId: "there" };
  try {
    watch.updateSessions([here, other]);
    watch.updateSessions([here, { ...other, state: "idle" }]);
    expect(handlers.onSessionHint).not.toHaveBeenCalled();
    watch.updateSessions([{ ...here, state: "idle" }]);
    watch.updateSessions([{ ...here, state: "idle" }]);
    expect(handlers.onSessionHint).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);

    firstResponse.resolve(ready);
    await Bun.sleep(0);
    expect(call).toHaveBeenCalledTimes(2);

    watch.updateSessions([here]);
    host.show("hidden");
    watch.updateSessions([{ ...here, state: "idle" }]);
    expect(handlers.onSessionHint).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
    host.show("visible");
    expect(handlers.onSessionHint).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(3);
    await Bun.sleep(0);
  } finally {
    watch.stop();
    call.mockRestore();
  }
});

test("a rejected Git method stops polling", async () => {
  const denied = ipcErr("unsupported", "method not found");
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(denied);
  const host = desktop();
  const handlers = callbacks();
  const watch = watchPeerGitStatus(peer, handlers, host);
  try {
    await Bun.sleep(0);
    expect(handlers.onResult).toHaveBeenCalledWith(denied);
    host.tick();
    host.focus();
    watch.refresh();
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    watch.stop();
    call.mockRestore();
  }
});

test("a running session missing from a complete list refreshes Git and invalidates the tree", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ready);
  const host = desktop();
  const handlers = callbacks();
  const watch = watchPeerGitStatus(peer, handlers, host);
  try {
    await Bun.sleep(0);
    watch.updateSessions([
      {
        workspaceId: peer.workspaceId,
        tabId: "closed",
        kind: "codex",
        title: "Closed",
        state: "running",
      },
    ]);
    watch.updateSessions([], true);
    expect(handlers.onSessionHint).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
    watch.updateSessions([]);
    watch.updateSessions([]);
    expect(handlers.onSessionHint).toHaveBeenCalledTimes(1);
    await Bun.sleep(0);
    expect(call).toHaveBeenCalledTimes(2);
  } finally {
    watch.stop();
    call.mockRestore();
  }
});
