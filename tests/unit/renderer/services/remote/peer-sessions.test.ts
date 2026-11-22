import { expect, mock, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  observePeerSessions,
  type PeerSessions,
  refreshPeerSessions,
} from "../../../../../src/renderer/services/remote/room";
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
    const initial = { status: "ready", list };
    expect(sidebar).toHaveBeenLastCalledWith(initial);
    expect(pane).toHaveBeenLastCalledWith(initial);
    expect(call.mock.calls).toEqual([["remote", "peerSessionsWatch", { deviceId: "d2" }]]);

    refreshPeerSessions("d2");
    await Promise.resolve();
    expect(sidebar).toHaveBeenCalledTimes(2);
    expect(pane).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]).toEqual(["remote", "peerSessions", { deviceId: "d2" }]);

    closeSidebar();
    expect(call).toHaveBeenCalledTimes(2);
  } finally {
    closePane();
    expect(call.mock.calls[2]).toEqual([
      "remote",
      "peerSessionsUnwatch",
      { deviceId: "d2", watchId: "watch" },
    ]);
    call.mockRestore();
    listen.mockRestore();
  }
});
