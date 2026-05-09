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

import { openExternalEditor } from "../../../../../src/renderer/services/editor/tabs";
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

  // merged from 3 separate tests per audit IMPORTANT-4
  it("creates external read-only tab with isPreview=true and initialized layout", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

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
    expect(tabs[0]?.isPreview).toBe(true);

    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
  });

  // Documents the dedup contract per audit recommendation: openExternalEditor
  // delegates to openEditorTab which does NOT dedup by filePath. Two calls
  // with the same filePath create two distinct tabs. Callers that want
  // dedup-and-reveal should use openOrRevealEditor instead.
  it("does NOT dedup — two calls with same filePath create two distinct tabs", () => {
    const FILE = "/external/lib/util.py";

    const first = openExternalEditor({ workspaceId: WS, filePath: FILE });
    const second = openExternalEditor({ workspaceId: WS, filePath: FILE });

    expect(first.tabId).not.toBe(second.tabId);

    const tabs = tabsFor(WS);
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab?.type).toBe("editor");
      if (tab?.type === "editor") {
        expect(tab.props.filePath).toBe(FILE);
        expect(tab.props.origin).toBe("external");
        expect(tab.props.readOnly).toBe(true);
      }
    }
  });
});
