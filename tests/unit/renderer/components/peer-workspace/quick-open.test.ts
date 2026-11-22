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
  function press(platform: "darwin" | "win32" | "linux", terminal = false): boolean {
    const mac = platform === "darwin";
    setPlatformForTests(platform);
    return handleGlobalKeyDown({
      key: "p",
      code: "KeyP",
      metaKey: mac,
      ctrlKey: !mac,
      shiftKey: false,
      altKey: false,
      target: terminal
        ? { closest: (selector: string) => (selector === ".xterm" ? {} : null) }
        : null,
      preventDefault() {},
    } as KeyboardEvent);
  }
  try {
    useAgentViewStore.setState({ mode: "workspace" });
    savedPeer.clearSelection();
    expect(press("darwin")).toBe(false);
    expect(press("win32")).toBe(false);
    savedPeer.select(target, "local");
    expect(press("darwin")).toBe(true);
    expect(press("win32")).toBe(true);
    expect(press("darwin", true)).toBe(true);
    expect(press("win32", true)).toBe(false);
    expect(press("linux", true)).toBe(false);
    useAgentViewStore.setState({ mode: "agents" });
    expect(press("darwin")).toBe(false);
    expect(fromCommand).toEqual(Array(3).fill(peerTargetId(target)));
  } finally {
    off();
    for (const stop of unregister) stop();
    usePeerWorkspaceStore.setState(savedPeer, true);
    useAgentViewStore.setState(savedAgentView, true);
    setPlatformForTests(null);
  }
});

test("quick open discards paths outside a UNC workspace", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
    ipcOk({ files: ["../Run.ts", "..\\Run.ts", "/Run.ts", "D:\\Run.ts", "src/Run.ts"] }),
  );
  try {
    const windows = {
      ...target,
      platform: "win32" as const,
      workspace: { ...target.workspace, path: "\\\\Server\\Share\\Project" },
    };
    const source = createPeerQuickOpenSource({ t, target: windows, canRead: true, blocked: null });
    expect(await source.search("Run", new AbortController().signal)).toEqual([
      { id: "4", path: "src/Run.ts", label: "Run.ts", detail: "src/Run.ts" },
    ]);
  } finally {
    call.mockRestore();
  }
});

test("quick open localizes transport failures and preserves cancellations and late responses", async () => {
  const response = Promise.withResolvers<ReturnType<typeof ipcErr>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockRejectedValueOnce(new Error("transport detail"))
    .mockImplementationOnce(() => {
      throw new Error("synchronous transport failure");
    })
    .mockImplementationOnce(() => response.promise);
  const before = usePeerWorkspaceStore.getState();
  try {
    before.select(target, null);
    const source = createPeerQuickOpenSource({ t, target, canRead: true, blocked: null });
    const controller = new AbortController();
    for (let i = 0; i < 2; i++) {
      const error = await source.search("test", controller.signal).catch((error) => error);
      expect(source.errorMessage?.(error)).toBe("Disconnected on that computer");
    }

    const pending = source.search("test", controller.signal);
    controller.abort();
    response.resolve(ipcErr("not-found", "no such workspace"));
    expect(await pending.catch((error) => error)).toBe(controller.signal.reason);
    expect(usePeerWorkspaceStore.getState().missing).toBe(false);
  } finally {
    call.mockRestore();
    usePeerWorkspaceStore.setState(before, true);
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
