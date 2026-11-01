import { afterAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { portsLabel } from "../../../../../src/shared/pty/ports";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;
// Window IPC stub — the stores check for window.ipc on import.
globals.window ??= {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
};

afterAll(() => {
  globals.window = originalWindow;
});

const { PortsSegmentView } = await import(
  "../../../../../src/renderer/components/workbench/ports-segment"
);
const { usePortsStore } = await import("../../../../../src/renderer/state/stores/ports");

function listening(...ports: number[]) {
  return ports.map((port) => ({ port, pid: port, process: "node", tabId: "t" }));
}

describe("PortsSegmentView", () => {
  test("renders nothing while no program listens", () => {
    expect(renderToStaticMarkup(<PortsSegmentView workspaceId="ws" ports={[]} />)).toBe("");
  });

  test("lists the ports, the ones past three as +N, and all of them in its title", () => {
    const html = renderToStaticMarkup(
      <PortsSegmentView workspaceId="ws" ports={listening(3000, 5173, 6006, 8787)} />,
    );

    expect(html).toContain(":3000 :5173 :6006 +1");
    expect(html).toContain('title="Listening ports :3000 :5173 :6006 :8787 — click to open"');
  });
});

describe("portsLabel", () => {
  test("lists up to max ports", () => {
    expect(portsLabel(listening(5173), 2)).toBe(":5173");
    expect(portsLabel(listening(5173, 8787), 2)).toBe(":5173 :8787");
    expect(portsLabel(listening(3000, 5173, 8787), 2)).toBe(":3000 :5173 +1");
  });
});

describe("usePortsStore", () => {
  test("a workspace whose servers stopped is dropped", () => {
    usePortsStore.setState({ byWorkspace: {}, changed: {} });
    const store = usePortsStore.getState();
    store.set({ workspaceId: "ws", ports: listening(3000) });
    store.set({ workspaceId: "ws", ports: [] });

    expect(usePortsStore.getState().byWorkspace).toEqual({});
  });

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
