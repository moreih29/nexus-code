/**
 * tab-bar.tsx render tests.
 *
 * Uses renderToStaticMarkup (no DOM) so no jsdom/happy-dom dependency.
 * All stateful hooks are mocked at the module level before importing the
 * component, following the pattern established in outline-section.test.tsx.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EditorTab, Tab } from "../../../../../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Window IPC stub — must precede any module that calls ipcListen at init time
// (e.g. the tabs store).
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock hook dependencies before importing the component
// ---------------------------------------------------------------------------

// ipc/client — needed by tabs store's ipcListen call
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: () => Promise.resolve(),
  ipcListen: () => () => {},
}));

// Editor services — subscribeFileDirty / isDirty / filePathToModelUri used by
// useTabDirty. Provide a comprehensive stub to avoid process-global pollution
// when this module is loaded before other tests that need additional exports.
mock.module("../../../../../../src/renderer/services/editor", () => ({
  filePathToModelUri: (p: string) => `file://${p}`,
  isDirty: () => false,
  subscribeFileDirty: () => () => {},
  openOrRevealEditor: () => null,
  closeEditor: () => {},
  closeEditorWithConfirm: async () => "closed",
  saveModel: async () => ({ kind: "ok" }),
  cacheUriToFilePath: (uri: string) => {
    if (!uri.startsWith("file://")) return null;
    try {
      return uri.slice("file://".length).split("/").map(decodeURIComponent).join("/");
    } catch {
      return uri.slice("file://".length);
    }
  },
  findEditorTab: () => null,
  findEditorTabInGroup: () => null,
  findPreviewTabInGroup: () => null,
  PREVIEW_ENABLED: true,
  initializeEditorServices: () => {},
}));

// DND hook — useDragSource reads DOM events; just return a no-op onDragStart.
mock.module("../../../../../../src/renderer/components/ui/use-drag-source", () => ({
  useDragSource: () => ({ onDragStart: () => {} }),
}));

// Drop-target hook — barRef/tabsListRef/insertion; return null refs + no insertion.
mock.module(
  "../../../../../../src/renderer/components/workspace/dnd/use-tab-bar-drop-target",
  () => ({
    useTabBarDropTarget: () => ({
      barRef: { current: null },
      tabsListRef: { current: null },
      insertion: null,
    }),
  }),
);

// ---------------------------------------------------------------------------
// Import after all mocks are in place
// ---------------------------------------------------------------------------

const { TabBar } = await import("../../../../../../src/renderer/components/workspace/tabs/tab-bar");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEditorTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: "tab-1",
    title: "index.ts",
    isPreview: false,
    isPinned: false,
    type: "editor",
    props: {
      workspaceId: "ws-1",
      filePath: "/workspace/src/index.ts",
    },
    ...overrides,
  };
}

function renderBar(tabs: Tab[], activeTabId = "tab-1"): string {
  return renderToStaticMarkup(
    <TabBar
      workspaceId="ws-1"
      leafId="leaf-1"
      tabs={tabs}
      activeTabId={activeTabId}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onNewTerminalTab={() => {}}
    />,
  );
}

// ---------------------------------------------------------------------------
// Lock icon tests
// ---------------------------------------------------------------------------

describe("TabBar — Lock icon for readOnly tabs", () => {
  test("readOnly=true tab renders Lock icon with aria-label='Read-only'", () => {
    const tab = makeEditorTab({
      props: {
        workspaceId: "ws-1",
        filePath: "/external/lib/index.ts",
        readOnly: true,
        origin: "external",
      },
    });
    const html = renderBar([tab]);
    expect(html).toContain('aria-label="Read-only"');
  });

  test("readOnly=false tab does NOT render Lock icon", () => {
    const tab = makeEditorTab();
    const html = renderBar([tab]);
    expect(html).not.toContain('aria-label="Read-only"');
  });

  test("origin=external tab renders Lock icon", () => {
    const tab = makeEditorTab({
      props: {
        workspaceId: "ws-1",
        filePath: "/external/lib/index.ts",
        origin: "external",
      },
    });
    const html = renderBar([tab]);
    expect(html).toContain('aria-label="Read-only"');
  });
});

// ---------------------------------------------------------------------------
// Basename disambig tests
// ---------------------------------------------------------------------------

describe("TabBar — external tab basename disambiguation", () => {
  test("two external tabs with same basename get parent-dir suffix", () => {
    const tab1: EditorTab = {
      id: "tab-a",
      title: "index.ts",
      isPreview: false,
      isPinned: false,
      type: "editor",
      props: {
        workspaceId: "ws-1",
        filePath: "/proj/moduleA/index.ts",
        origin: "external",
      },
    };
    const tab2: EditorTab = {
      id: "tab-b",
      title: "index.ts",
      isPreview: false,
      isPinned: false,
      type: "editor",
      props: {
        workspaceId: "ws-1",
        filePath: "/proj/moduleB/index.ts",
        origin: "external",
      },
    };
    const html = renderBar([tab1, tab2], "tab-a");
    // Both parent-dir suffixes should appear
    expect(html).toContain("moduleA");
    expect(html).toContain("moduleB");
    // The separator should appear twice
    const separatorCount = (html.match(/·/g) ?? []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(2);
  });

  test("single external tab with unique basename has no parent-dir suffix", () => {
    const tab: EditorTab = {
      id: "tab-a",
      title: "unique.ts",
      isPreview: false,
      isPinned: false,
      type: "editor",
      props: {
        workspaceId: "ws-1",
        filePath: "/proj/moduleA/unique.ts",
        origin: "external",
      },
    };
    const html = renderBar([tab]);
    expect(html).not.toContain("·");
  });

  test("non-external tabs with same basename do NOT get suffix", () => {
    const tab1: EditorTab = {
      id: "tab-a",
      title: "index.ts",
      isPreview: false,
      isPinned: false,
      type: "editor",
      props: {
        workspaceId: "ws-1",
        filePath: "/proj/moduleA/index.ts",
      },
    };
    const tab2: EditorTab = {
      id: "tab-b",
      title: "index.ts",
      isPreview: false,
      isPinned: false,
      type: "editor",
      props: {
        workspaceId: "ws-1",
        filePath: "/proj/moduleB/index.ts",
      },
    };
    const html = renderBar([tab1, tab2], "tab-a");
    expect(html).not.toContain("·");
  });
});
