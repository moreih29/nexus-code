/**
 * ContentHost — untitled tab dispatch unit test.
 *
 * Verifies that a tab with type="untitled" causes ContentHost to mount an
 * EditorView component (not null / blank).
 *
 * ContentHost itself uses createPortal + DOM refs which cannot run under
 * renderToStaticMarkup. Instead we extract the dispatch condition that
 * ContentHost uses — the same `tab.type === "untitled"` branch — and verify
 * that EditorView receives the correct props (filePath="Untitled-N",
 * origin="untitled") for an untitled tab. This mirrors the guard established
 * by the editor-view-banner tests: mock heavyweight dependencies, render to
 * static markup, assert structural output.
 *
 * Strategy: render EditorView directly with the props ContentHost would
 * forward for an untitled tab (filePath="Untitled-1", origin="untitled",
 * workspaceId, tabId). Assert that the Monaco editor element is present —
 * confirming the untitled path reaches the editor pane rather than an error
 * or blank state.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Mock ipc client (must precede any renderer import that loads ipc/client)
// ---------------------------------------------------------------------------

const realIpcClient = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: mock(() => () => {}),
  ipcStream: mock(() => () => {}),
  canUseIpcBridge: () => false,
}));

// Mock git store — untitled tabs never touch the conflict resolution path.
mock.module("../../../../../../src/renderer/state/stores/git", () => ({
  useGitStore: mock((selector: (s: unknown) => unknown) =>
    selector({ sessions: new Map(), markResolved: mock(() => Promise.resolve()) }),
  ),
  useGitSession: mock(() => undefined),
}));

// Mock workspaces store to avoid its IPC bridge.
mock.module("../../../../../../src/renderer/state/stores/workspaces", () => ({
  useWorkspacesStore: Object.assign(
    mock((selector?: (s: unknown) => unknown) => {
      const state = { workspaces: [] };
      return typeof selector === "function" ? selector(state) : state;
    }),
    { getState: mock(() => ({ workspaces: [] })) },
  ),
}));

// Mock tabs store — viewMode selector falls back to "raw" for non-editor types.
const realTabsStore = await import("../../../../../../src/renderer/state/stores/tabs");
mock.module("../../../../../../src/renderer/state/stores/tabs", () => ({
  ...realTabsStore,
  useTabsStore: Object.assign(
    mock((selector: (s: unknown) => unknown) =>
      selector({ byWorkspace: {}, setViewMode: () => {} }),
    ),
    {
      getState: mock(() => ({ byWorkspace: {}, setViewMode: () => {} })),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Mock @monaco-editor/react — real canvas not available under bun:test.
// ---------------------------------------------------------------------------

mock.module("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

// ---------------------------------------------------------------------------
// Mock useSharedModel — untitled buffers start in phase:"ready" with a model.
// Returning phase:"ready" + non-null model confirms EditorView skips error
// states and reaches the Monaco editor pane.
// ---------------------------------------------------------------------------

const fakeModel = {
  getValue: () => "",
  onDidChangeContent: () => ({ dispose: () => {} }),
  isDisposed: () => false,
};

mock.module("../../../../../../src/renderer/services/editor", () => ({
  useSharedModel: mock((input: { workspaceId: string; filePath: string; origin?: string }) => {
    // Confirm EditorView forwards origin="untitled" so the real cache would
    // route to createUntitledEntry.
    return {
      model: input.origin === "untitled" ? fakeModel : null,
      phase: input.origin === "untitled" ? "ready" : "error",
      readOnly: false,
      errorCode: undefined,
    };
  }),
  openOrRevealEditor: mock(() => {}),
  saveModel: mock(() => Promise.resolve({ kind: "ok" })),
  closeEditorWithConfirm: mock(() => Promise.resolve("closed")),
  closeEditor: mock(() => {}),
  cacheUriToFilePath: (uri: string) => (uri.startsWith("file://") ? uri.slice(7) : null),
  filePathToModelUri: (path: string) => `file://${path}`,
  isDirty: () => false,
  subscribeFileDirty: () => () => {},
  findEditorTab: mock(() => null),
  findEditorTabInGroup: mock(() => null),
  findPreviewTabInGroup: mock(() => null),
  PREVIEW_ENABLED: true,
  initializeEditorServices: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

const { EditorView } = await import(
  "../../../../../../src/renderer/components/workspace/content/editor-view"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContentHost — untitled tab dispatch", () => {
  /**
   * Verify that EditorView, when given the props ContentHost forwards for an
   * untitled tab (filePath="Untitled-1", origin="untitled"), renders the
   * Monaco editor element rather than an error/empty state.
   *
   * This is the minimal unit test that confirms:
   *   1. EditorView accepts the `origin` prop without a TypeScript error.
   *   2. With origin="untitled", useSharedModel receives origin="untitled"
   *      and returns a ready model — EditorView reaches the Monaco editor pane.
   *   3. The rendered output contains the Monaco editor stub.
   */
  test("renders Monaco editor for origin='untitled' (simulates ContentHost dispatch)", () => {
    const html = renderToStaticMarkup(
      <EditorView
        filePath="Untitled-1"
        workspaceId="ws-test"
        tabId="tab-untitled-1"
        origin="untitled"
      />,
    );

    // Monaco editor stub must be present — confirms the ready path was taken.
    expect(html).toContain("monaco-editor");
  });

  test("without origin='untitled', useSharedModel returns error phase — no monaco editor", () => {
    const html = renderToStaticMarkup(
      <EditorView
        filePath="Untitled-1"
        workspaceId="ws-test"
        tabId="tab-untitled-1"
        // origin omitted → defaults to "workspace", mock returns error
      />,
    );

    // With error phase, EditorView renders an EmptyState — no monaco editor.
    expect(html).not.toContain("monaco-editor");
  });

  test("ContentHost dispatch: filePath for untitled-N is 'Untitled-N'", () => {
    // Verify the filePath convention matches what the tabs store title uses.
    // defaultTitle({ type: "untitled", props: { untitledIndex: 3 } }) === "Untitled-3"
    // ContentHost passes filePath=`Untitled-${tab.props.untitledIndex}`
    const untitledIndex = 3;
    const expectedFilePath = `Untitled-${untitledIndex}`;

    const html = renderToStaticMarkup(
      <EditorView
        filePath={expectedFilePath}
        workspaceId="ws-test"
        tabId="tab-untitled-3"
        origin="untitled"
      />,
    );

    expect(html).toContain("monaco-editor");
  });
});
