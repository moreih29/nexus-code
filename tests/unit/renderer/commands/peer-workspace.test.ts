import { afterEach, expect, spyOn, test } from "bun:test";
import {
  newPeerWorkspaceTerminal,
  runPeerTabCommand,
} from "../../../../src/renderer/commands/domains/peer-workspace";
import * as ipc from "../../../../src/renderer/ipc/client";
import {
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../src/renderer/state/stores/peer-workspace";
import { ipcOk } from "../../../../src/shared/ipc/result";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "desktop",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const id = peerTargetId(target);
const previous = usePeerWorkspaceStore.getState();

afterEach(() => usePeerWorkspaceStore.setState(previous, true));

test("the tab commands close and cycle a peer workspace's tabs", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  store.openFile(id, "/repo/a.ts");
  store.openFile(id, "/repo/b.ts");
  store.openFile(id, "/repo/c.ts");
  const keys = () => usePeerWorkspaceStore.getState().views[id]?.tabs.map(peerTabId) ?? [];
  const front = () => usePeerWorkspaceStore.getState().views[id]?.activePath;
  expect(keys()).toHaveLength(3);
  const [a, b, c] = keys();
  expect(front()).toBe(c);
  expect(runPeerTabCommand("next")).toBe(true);
  expect(front()).toBe(a);
  runPeerTabCommand("previous");
  expect(front()).toBe(c);
  runPeerTabCommand("close");
  expect(keys()).toEqual([a, b]);
  usePeerWorkspaceStore.getState().selectTab(id, a as string);
  runPeerTabCommand("closeOthers");
  expect(keys()).toEqual([a]);
  runPeerTabCommand("closeAll");
  expect(keys()).toEqual([]);
});

test("no peer workspace shown, the tab commands are not the peer's", () => {
  usePeerWorkspaceStore.setState({ active: null });
  expect(runPeerTabCommand("close")).toBe(false);
});

test("⌘T opens a terminal there only where that computer lets this one control its terminals", async () => {
  usePeerWorkspaceStore.getState().select(target, null);
  for (const serves of [["terminal.read"], ["terminal.control"]]) {
    const call = spyOn(ipc, "ipcCallResult").mockImplementation((async (
      _channel: string,
      method: string,
    ) =>
      method === "room"
        ? ipcOk({
            status: "online",
            peers: [{ id: "desktop", name: "Desktop", platform: "linux", online: true, serves }],
          })
        : ipcOk({ tabId: "t1" })) as unknown as typeof ipc.ipcCallResult);
    try {
      expect(newPeerWorkspaceTerminal()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const opened = call.mock.calls.some(([, method]) => method === "peerTerminalOpen");
      expect(opened).toBe(serves.includes("terminal.control"));
    } finally {
      call.mockRestore();
    }
  }
});
