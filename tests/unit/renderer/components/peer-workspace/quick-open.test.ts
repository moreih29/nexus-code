import { expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import { registerPaletteCommands } from "../../../../../src/renderer/commands/domains/palette";
import { createPeerQuickOpenSource } from "../../../../../src/renderer/components/peer-workspace/quick-open";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { handleGlobalKeyDown } from "../../../../../src/renderer/keybindings/dispatcher";
import { subscribePeerQuickOpen } from "../../../../../src/renderer/services/remote/peer-quick-open";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";
import { setPlatformForTests } from "../../../../../src/renderer/utils/platform";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "device",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "workspace",
  workspace: { id: "workspace", name: "Workspace", path: "/home/demo" },
};
const t = i18next.t.bind(i18next);

test("Cmd/Ctrl+P dispatches only in the peer workspace view", () => {
  const savedPeer = usePeerWorkspaceStore.getState();
  const savedAgentView = useAgentViewStore.getState();
  const fromCommand: string[] = [];
  const off = subscribePeerQuickOpen((id) => fromCommand.push(id));
  const unregister = registerPaletteCommands();
  function press(mac: boolean): boolean {
    setPlatformForTests(mac ? "darwin" : "win32");
    return handleGlobalKeyDown({
      key: "p",
      code: "KeyP",
      metaKey: mac,
      ctrlKey: !mac,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
    } as KeyboardEvent);
  }
  try {
    useAgentViewStore.setState({ mode: "workspace" });
    savedPeer.clearSelection();
    expect(press(true)).toBe(false);
    expect(press(false)).toBe(false);
    savedPeer.select(target, "local");
    expect(press(true)).toBe(true);
    expect(press(false)).toBe(true);
    useAgentViewStore.setState({ mode: "agents" });
    expect(press(true)).toBe(false);
    expect(fromCommand).toEqual([peerTargetId(target), peerTargetId(target)]);
  } finally {
    off();
    for (const stop of unregister) stop();
    usePeerWorkspaceStore.setState(savedPeer, true);
    useAgentViewStore.setState(savedAgentView, true);
    setPlatformForTests(null);
  }
});

test("quick open asks the selected host for up to 200 files and opens the chosen path", async () => {
  const reply = {
    files: Array.from({ length: 205 }, (_, i) => `src/file-${i}.ts`),
    truncated: true,
  };
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(reply));
  const before = usePeerWorkspaceStore.getState();
  const signal = new AbortController().signal;
  try {
    before.select(target, null);
    const source = createPeerQuickOpenSource({ t, target, canRead: true, blocked: null });
    const items = await source.search("  file  ", signal);
    expect(call).toHaveBeenCalledWith(
      "remote",
      "peerFilesFind",
      {
        deviceId: target.deviceId,
        workspaceId: target.workspaceId,
        query: "file",
        limit: 200,
      },
      { signal },
    );
    expect(items).toHaveLength(200);
    expect(items[0]).toMatchObject({ label: "file-0.ts", detail: "src/file-0.ts" });
    source.accept(items[0]);
    expect(usePeerWorkspaceStore.getState().views[peerTargetId(target)]?.activePath).toBe(
      "/home/demo/src/file-0.ts",
    );
  } finally {
    call.mockRestore();
    usePeerWorkspaceStore.setState(before, true);
  }
});

test("an unsupported find returns the update message and an offline find never calls IPC", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
    ipcErr("unsupported", "MethodNotFound"),
  );
  const signal = new AbortController().signal;
  try {
    const online = createPeerQuickOpenSource({ t, target, canRead: true, blocked: null });
    await expect(online.search("test", signal)).rejects.toThrow(
      "App update needed on that computer",
    );
    const blocked = "Desktop offline · Last viewed content";
    const offline = createPeerQuickOpenSource({ t, target, canRead: false, blocked });
    await expect(offline.search("test", signal)).rejects.toThrow(blocked);
    expect(offline.emptyQueryMessage).toBe(blocked);
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    call.mockRestore();
  }
});
