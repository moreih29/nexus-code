import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal shims so Zustand can run in bun (no DOM / ipcListen needed)
// ---------------------------------------------------------------------------

// Stub window.ipc so the tabs store's ipcListen call doesn't throw.
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// Stub crypto.randomUUID with a deterministic counter-based implementation.
if (typeof (globalThis as Record<string, unknown>).crypto === "undefined") {
  let counter = 0;
  (globalThis as Record<string, unknown>).crypto = {
    randomUUID: () => {
      counter++;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Import store after shims
// ---------------------------------------------------------------------------

import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";

function reset() {
  useTabsStore.setState({ byWorkspace: {} });
}

// ---------------------------------------------------------------------------
// createTab — title derivation and accumulation are the only behaviors
// worth pinning. The "value goes in and comes back" round-trip is a
// setter echo that adds no scenario value.
// ---------------------------------------------------------------------------

describe("useTabsStore — createTab", () => {
  beforeEach(reset);

  it("derives title 'Terminal' for terminal type", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    expect(tab.title).toBe("Terminal");
  });

  it("derives title from filePath basename for editor type", () => {
    const tab = useTabsStore.getState().createTab(WS_A, {
      type: "editor",
      props: { filePath: "/project/src/main.ts", workspaceId: WS_A },
    });
    expect(tab.title).toBe("main.ts");
  });

  it("accumulates multiple tabs in the same workspace record", () => {
    useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/tmp" } });

    const ids = Object.keys(useTabsStore.getState().byWorkspace[WS_A]);
    expect(ids).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// removeTab
// ---------------------------------------------------------------------------

describe("useTabsStore — removeTab", () => {
  beforeEach(reset);

  it("removes the specified tab from the workspace record", () => {
    const t1 = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/tmp" } });

    useTabsStore.getState().removeTab(WS_A, t1.id);

    const wsRecord = useTabsStore.getState().byWorkspace[WS_A];
    expect(wsRecord[t1.id]).toBeUndefined();
    expect(Object.keys(wsRecord)).toHaveLength(1);
  });

  it("does not touch other workspace records", () => {
    const ta = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/a" } });
    const tb = useTabsStore.getState().createTab(WS_B, { type: "terminal", props: { cwd: "/b" } });

    useTabsStore.getState().removeTab(WS_A, ta.id);

    expect(useTabsStore.getState().byWorkspace[WS_B][tb.id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// renameTab
// ---------------------------------------------------------------------------

describe("useTabsStore — renameTab", () => {
  beforeEach(reset);

  it("updates the title of the specified tab", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });

    useTabsStore.getState().renameTab(WS_A, tab.id, "My Session");

    expect(useTabsStore.getState().byWorkspace[WS_A][tab.id].title).toBe("My Session");
  });

  it("does not mutate other fields of the tab", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().renameTab(WS_A, tab.id, "Renamed");

    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.id).toBe(tab.id);
    expect(updated.type).toBe(tab.type);
    expect(updated.props).toEqual(tab.props);
  });

  it("renameTab은 customTitle을 갱신하고 defaultTitle/processTitle은 그대로 둔다", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().setProcessTitle(WS_A, tab.id, "claude");
    useTabsStore.getState().renameTab(WS_A, tab.id, "내 작업창");

    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.title).toBe("내 작업창");
    expect(updated.customTitle).toBe("내 작업창");
    expect(updated.processTitle).toBe("claude"); // 보존
    expect(updated.defaultTitle).toBe("Terminal"); // 보존
  });

  it("renameTab(\"\")는 customTitle을 clear해 processTitle로 복귀시킨다", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().setProcessTitle(WS_A, tab.id, "lazygit");
    useTabsStore.getState().renameTab(WS_A, tab.id, "Override");
    expect(useTabsStore.getState().byWorkspace[WS_A][tab.id].title).toBe("Override");

    useTabsStore.getState().renameTab(WS_A, tab.id, "");
    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.customTitle).toBeUndefined();
    expect(updated.title).toBe("lazygit"); // processTitle로 복귀
  });

  it("custom 없이 process 없이는 defaultTitle로 복귀", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().renameTab(WS_A, tab.id, "X");
    useTabsStore.getState().renameTab(WS_A, tab.id, "");

    expect(useTabsStore.getState().byWorkspace[WS_A][tab.id].title).toBe("Terminal");
  });
});

// ---------------------------------------------------------------------------
// setProcessTitle — 자동 감지 타이틀 갱신
// ---------------------------------------------------------------------------

describe("useTabsStore — setProcessTitle", () => {
  beforeEach(reset);

  it("processTitle 설정 시 customTitle 없으면 display title 갱신", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().setProcessTitle(WS_A, tab.id, "lazygit");

    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.processTitle).toBe("lazygit");
    expect(updated.title).toBe("lazygit");
  });

  it("customTitle 있으면 processTitle 변경이 display title을 흔들지 않는다", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().renameTab(WS_A, tab.id, "Pinned");
    useTabsStore.getState().setProcessTitle(WS_A, tab.id, "lazygit");

    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.title).toBe("Pinned"); // customTitle 우선
    expect(updated.processTitle).toBe("lazygit"); // 값은 갱신됨 — 추후 custom clear 시 복귀용
  });

  it("setProcessTitle(null)은 processTitle clear", () => {
    const tab = useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().setProcessTitle(WS_A, tab.id, "lazygit");
    useTabsStore.getState().setProcessTitle(WS_A, tab.id, null);

    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal"); // defaultTitle로 복귀
  });
});

// ---------------------------------------------------------------------------
// closeAllForWorkspace
// ---------------------------------------------------------------------------

describe("useTabsStore — closeAllForWorkspace", () => {
  beforeEach(reset);

  it("removes the workspace's record entirely", () => {
    useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/a" } });
    useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/a2" } });

    useTabsStore.getState().closeAllForWorkspace(WS_A);

    expect(useTabsStore.getState().byWorkspace[WS_A]).toBeUndefined();
  });

  it("leaves other workspace records intact", () => {
    const tb = useTabsStore.getState().createTab(WS_B, { type: "terminal", props: { cwd: "/b" } });
    useTabsStore.getState().createTab(WS_A, { type: "terminal", props: { cwd: "/a" } });

    useTabsStore.getState().closeAllForWorkspace(WS_A);

    const state = useTabsStore.getState();
    expect(state.byWorkspace[WS_A]).toBeUndefined();
    expect(state.byWorkspace[WS_B][tb.id]).toBeDefined();
  });
});
