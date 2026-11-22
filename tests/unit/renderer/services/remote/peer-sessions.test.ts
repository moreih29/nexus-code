import { expect, mock, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { remoteSessionKey } from "../../../../../src/renderer/services/agent-view/layout";
import {
  observePeerSessions,
  type PeerSessions,
  refreshPeerSessions,
} from "../../../../../src/renderer/services/remote/room";
import {
  type RemoteTarget,
  useRemoteViewStore,
} from "../../../../../src/renderer/state/stores/remote-view";
import { ipcOk } from "../../../../../src/shared/ipc/result";

test("the sidebar and panes share a device's sessions watch and refresh", async () => {
  const list = { sessions: [], workspaces: [] };
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async (_, method) =>
    ipcOk(method === "peerSessionsWatch" ? { ...list, watchId: "watch" } : list),
  );
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const sidebar = mock((_sessions: PeerSessions) => {});
  const pane = mock((_sessions: PeerSessions) => {});
  const closeSidebar = observePeerSessions("d2", 0, sidebar);
  await Promise.resolve();
  const closePane = observePeerSessions("d2", 0, pane);
  try {
    const initial = { status: "ready", list, requested: expect.any(Number) };
    expect(sidebar).toHaveBeenLastCalledWith(initial);
    expect(pane).toHaveBeenLastCalledWith(initial);
    expect(call.mock.calls).toEqual([["remote", "peerSessionsWatch", { deviceId: "d2" }]]);

    refreshPeerSessions("d2");
    refreshPeerSessions("d2");
    await Bun.sleep(0);
    expect(sidebar).toHaveBeenCalledTimes(2);
    expect(pane).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]).toEqual(["remote", "peerSessions", { deviceId: "d2" }]);

    closeSidebar();
    expect(call).toHaveBeenCalledTimes(2);
  } finally {
    closePane();
    await Promise.resolve();
    expect(call.mock.calls[2]).toEqual([
      "remote",
      "peerSessionsUnwatch",
      { deviceId: "d2", watchId: "watch" },
    ]);
    call.mockRestore();
    listen.mockRestore();
  }
});

test("switching between workspace and agent sidebars keeps one sessions watch", async () => {
  const list = { sessions: [], workspaces: [] };
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () =>
    ipcOk({ ...list, watchId: "watch" }),
  );
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const workspace = observePeerSessions("d2", 0, () => {});
  let agent: (() => void) | undefined;
  try {
    await Promise.resolve();
    workspace();
    const receive = mock((_sessions: PeerSessions) => {});
    agent = observePeerSessions("d2", 0, receive);
    await Promise.resolve();
    expect(call.mock.calls).toEqual([["remote", "peerSessionsWatch", { deviceId: "d2" }]]);
    expect(receive).toHaveBeenCalledWith({ status: "ready", list, requested: expect.any(Number) });
  } finally {
    workspace();
    agent?.();
    await Promise.resolve();
    call.mockRestore();
    listen.mockRestore();
  }
});

test("releasing a watch twice leaves its replacement shared by new observers", async () => {
  const list = { sessions: [], workspaces: [] };
  let watchCount = 0;
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async (_, method) =>
    ipcOk(method === "peerSessionsWatch" ? { ...list, watchId: `watch-${++watchCount}` } : {}),
  );
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const release = observePeerSessions("d2", 0, () => {});
  let releaseReplacement: (() => void) | undefined;
  let releaseAdditional: (() => void) | undefined;
  try {
    await Promise.resolve();
    release();
    await Promise.resolve();
    releaseReplacement = observePeerSessions("d2", 0, () => {});
    await Promise.resolve();

    release();
    const additional = mock((_sessions: PeerSessions) => {});
    releaseAdditional = observePeerSessions("d2", 0, additional);
    expect(additional).toHaveBeenCalledWith({
      status: "ready",
      list,
      requested: expect.any(Number),
    });
    expect(call.mock.calls).toEqual([
      ["remote", "peerSessionsWatch", { deviceId: "d2" }],
      ["remote", "peerSessionsUnwatch", { deviceId: "d2", watchId: "watch-1" }],
      ["remote", "peerSessionsWatch", { deviceId: "d2" }],
    ]);
  } finally {
    releaseAdditional?.();
    releaseReplacement?.();
    release();
    await Promise.resolve();
    call.mockRestore();
    listen.mockRestore();
  }
});

test("a watched list marks an already open terminal as ended without a sidebar row", async () => {
  const target: RemoteTarget = {
    deviceId: "d2",
    deviceName: "Work PC",
    workspaceId: "w1",
    workspaceName: "api",
    path: "/src/api",
    tabId: "t1",
    kind: "terminal",
    title: "Claude",
    state: "needs-you",
    ask: { requestId: "ask", text: "Bash" },
  };
  const key = remoteSessionKey(target);
  const { targets } = useRemoteViewStore.getState();
  useRemoteViewStore.setState({ targets: new Map([[key, target]]) });
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async (_, method) =>
    ipcOk(
      method === "peerSessionsWatch"
        ? {
            watchId: "watch",
            sessions: [
              { workspaceId: "w1", tabId: "t1", kind: "terminal", title: "Claude", state: "ended" },
            ],
            workspaces: [],
          }
        : {},
    ),
  );
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const stop = observePeerSessions(target.deviceId, 0, () => {});
  try {
    await Promise.resolve();
    const updated = useRemoteViewStore.getState().targets.get(key);
    expect(updated?.state).toBe("ended");
    expect(updated).not.toHaveProperty("ask");
  } finally {
    stop();
    await Promise.resolve();
    call.mockRestore();
    listen.mockRestore();
    useRemoteViewStore.setState({ targets });
  }
});
