import { afterAll, describe, expect, test } from "bun:test";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;
// Window IPC stub — the stores check for window.ipc on import.
globals.window ??= {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
};

afterAll(() => {
  globals.window = originalWindow;
});

const { usePortsStore } = await import("../../../../../src/renderer/state/stores/ports");

function listening(...ports: number[]) {
  return ports.map((port) => ({ port, pid: port, process: "node", tabId: "t" }));
}

describe("usePortsStore", () => {
  test("hydrating does not bring back servers that stopped since", () => {
    usePortsStore.setState({ byWorkspace: {}, changed: {} });
    usePortsStore.getState().set({ workspaceId: "ws", ports: [] });
    usePortsStore.getState().hydrate([{ workspaceId: "ws", ports: listening(5173) }]);

    expect(usePortsStore.getState().byWorkspace).toEqual({});
  });

  test("hydrating keeps what a broadcast said since", () => {
    usePortsStore.setState({ byWorkspace: {}, changed: {} });
    usePortsStore.getState().set({ workspaceId: "ws", ports: listening(5174) });
    usePortsStore.getState().hydrate([
      { workspaceId: "ws", ports: listening(5173) },
      { workspaceId: "other", ports: listening(8000) },
    ]);

    expect(usePortsStore.getState().byWorkspace).toEqual({
      ws: listening(5174),
      other: listening(8000),
    });
  });
});
