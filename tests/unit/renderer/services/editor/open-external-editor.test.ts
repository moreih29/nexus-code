/**
 * Unit tests for openExternalEditor.
 *
 * Verifies that openExternalEditor creates a preview tab with origin="external"
 * and readOnly=true in the correct workspace.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

import { openExternalEditor } from "../../../../../src/renderer/services/editor/open-editor";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function tabsFor(workspaceId: string) {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
}

describe("openExternalEditor", () => {
  beforeEach(resetStores);

  it("creates a tab with origin=external and readOnly=true", () => {
    const location = openExternalEditor({ workspaceId: WS, filePath: "/external/lib/util.py" });

    expect(location.tabId).toBeDefined();
    expect(location.groupId).toBeDefined();

    const tabs = tabsFor(WS);
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    expect(tab?.type).toBe("editor");
    if (tab?.type === "editor") {
      expect(tab.props.origin).toBe("external");
      expect(tab.props.readOnly).toBe(true);
      expect(tab.props.filePath).toBe("/external/lib/util.py");
      expect(tab.props.workspaceId).toBe(WS);
    }
  });

  it("creates the tab as isPreview=true", () => {
    openExternalEditor({ workspaceId: WS, filePath: "/external/lib/util.py" });

    const tabs = tabsFor(WS);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.isPreview).toBe(true);
  });

  it("returns tabId matching the created tab", () => {
    const location = openExternalEditor({ workspaceId: WS, filePath: "/external/a.ts" });

    const tabs = tabsFor(WS);
    expect(tabs[0]?.id).toBe(location.tabId);
  });

  it("initializes the workspace layout when none exists", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

    openExternalEditor({ workspaceId: WS, filePath: "/external/a.ts" });

    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
  });
});
