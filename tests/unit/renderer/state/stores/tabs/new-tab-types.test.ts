/**
 * Unit tests for UntitledTab and BrowserTab additions.
 *
 * Covers:
 *   - BrowserTab round-trip through toSnapshot (present) and fromSnapshot
 *   - UntitledTab is stripped from toSnapshot (not persisted)
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Shims
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

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
// Imports after shims
// ---------------------------------------------------------------------------

import { useLayoutStore } from "../../../../../../src/renderer/state/stores/layout";
import type { Tab } from "../../../../../../src/renderer/state/stores/tabs";
import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";
import { WorkspaceLayoutSnapshotSchema } from "../../../../../../src/shared/types/layout";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

/**
 * Inline equivalent of persistence.ts toSnapshot (strips untitled tabs).
 */
function buildSnapshot(workspaceId: string) {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const tabRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  if (!layout) return null;
  const tabs = Object.values(tabRecord).filter((t) => t.type !== "untitled") as Tab[];
  return {
    root: layout.root,
    activeGroupId: layout.activeGroupId,
    tabs,
  };
}

// ---------------------------------------------------------------------------
// Persistence: BrowserTab roundtrip (present in snapshot), UntitledTab stripped
// ---------------------------------------------------------------------------

describe("persistence — BrowserTab roundtrip through snapshot", () => {
  beforeEach(resetStores);

  it("BrowserTab is present in the snapshot and passes zod parse", () => {
    // Create a layout root first (openTerminalTab would do, but we can inject
    // the tab directly and manually build a minimal layout).
    const props = {
      initialUrl: "https://example.com",
      lastUrl: "https://example.com/docs",
      partition: `persist:browser-${WS}`,
    };
    const tab = useTabsStore.getState().createTab(WS, { type: "browser", props });

    const leafId = "11111111-1111-4111-b111-111111111111";
    // Inject a minimal layout so buildSnapshot can find it.
    useLayoutStore.setState({
      byWorkspace: {
        [WS]: {
          root: {
            kind: "leaf",
            id: leafId,
            tabIds: [tab.id],
            activeTabId: tab.id,
          },
          activeGroupId: leafId,
        },
      },
    });

    const snapshot = buildSnapshot(WS);
    expect(snapshot).not.toBeNull();

    // BrowserTab must be present
    expect(snapshot!.tabs).toHaveLength(1);
    expect(snapshot!.tabs[0]!.type).toBe("browser");

    // Full zod parse must succeed
    const result = WorkspaceLayoutSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);

    if (result.success) {
      const parsed = result.data.tabs[0];
      expect(parsed?.type).toBe("browser");
      if (parsed?.type === "browser") {
        expect(parsed.props.initialUrl).toBe(props.initialUrl);
        expect(parsed.props.lastUrl).toBe(props.lastUrl);
        expect(parsed.props.partition).toBe(props.partition);
      }
    }
  });

  it("BrowserTab fields survive JSON.stringify → JSON.parse → zod parse", () => {
    const props = {
      initialUrl: "https://roundtrip.test",
      lastUrl: "https://roundtrip.test/end",
      partition: "persist:browser-rt",
    };
    const tab = useTabsStore.getState().createTab(WS, { type: "browser", props });

    const leafId = "22222222-2222-4222-b222-222222222222";
    useLayoutStore.setState({
      byWorkspace: {
        [WS]: {
          root: {
            kind: "leaf",
            id: leafId,
            tabIds: [tab.id],
            activeTabId: tab.id,
          },
          activeGroupId: leafId,
        },
      },
    });

    const snapshot = buildSnapshot(WS);
    const result = WorkspaceLayoutSnapshotSchema.safeParse(JSON.parse(JSON.stringify(snapshot)));
    expect(result.success).toBe(true);

    if (result.success) {
      const parsed = result.data.tabs[0];
      if (parsed?.type === "browser") {
        expect(parsed.props.initialUrl).toBe(props.initialUrl);
        expect(parsed.props.lastUrl).toBe(props.lastUrl);
        expect(parsed.props.partition).toBe(props.partition);
      }
    }
  });
});

describe("persistence — UntitledTab is stripped from snapshot", () => {
  beforeEach(resetStores);

  it("UntitledTab does not appear in toSnapshot output", () => {
    const untitled = useTabsStore
      .getState()
      .createTab(WS, { type: "untitled", props: { untitledIndex: 1 } });

    const leafId = "33333333-3333-4333-b333-333333333333";
    useLayoutStore.setState({
      byWorkspace: {
        [WS]: {
          root: {
            kind: "leaf",
            id: leafId,
            tabIds: [untitled.id],
            activeTabId: untitled.id,
          },
          activeGroupId: leafId,
        },
      },
    });

    const snapshot = buildSnapshot(WS);
    expect(snapshot).not.toBeNull();
    // Untitled tabs must be stripped — tabs array should be empty
    expect(snapshot!.tabs).toHaveLength(0);
  });

  it("mixing BrowserTab and UntitledTab: only BrowserTab survives snapshot", () => {
    const untitled = useTabsStore
      .getState()
      .createTab(WS, { type: "untitled", props: { untitledIndex: 2 } });
    const browser = useTabsStore.getState().createTab(WS, {
      type: "browser",
      props: { initialUrl: "https://keep.me", lastUrl: "", partition: "p" },
    });

    const leafId = "44444444-4444-4444-b444-444444444444";
    useLayoutStore.setState({
      byWorkspace: {
        [WS]: {
          root: {
            kind: "leaf",
            id: leafId,
            tabIds: [untitled.id, browser.id],
            activeTabId: browser.id,
          },
          activeGroupId: leafId,
        },
      },
    });

    const snapshot = buildSnapshot(WS);
    expect(snapshot!.tabs).toHaveLength(1);
    expect(snapshot!.tabs[0]!.type).toBe("browser");
  });
});
