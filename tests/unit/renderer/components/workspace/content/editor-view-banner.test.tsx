/**
 * editor-view.tsx — ReadOnlyBanner integration tests.
 *
 * Verifies that EditorView renders ReadOnlyBanner above the Editor when the
 * resolved model is readOnly, and omits it when the model is writable.
 *
 * Monaco and the Editor component are mocked to avoid DOM/canvas requirements.
 * useSharedModel is mocked to return a controllable snapshot.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Mock ipcCall before any import that would trigger the renderer ipc module
// ---------------------------------------------------------------------------

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Mock @monaco-editor/react — the Editor component renders a canvas in real
// code, which cannot run under bun:test (no DOM). Replace with a div stub.
// ---------------------------------------------------------------------------

mock.module("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

// ---------------------------------------------------------------------------
// Mock useSharedModel — we control the readOnly flag per test.
// cacheUriToFilePath uses the real file-uri implementation to avoid breaking
// tests that consume the function after this module's mock is installed
// (process-global pollution guard).
// ---------------------------------------------------------------------------

let mockReadOnly = false;
let mockPhase: "loading" | "ready" | "error" | "binary" = "ready";

// Real cacheUriToFilePath logic (mirrors src/shared/file-uri.ts so we don't
// need to load monaco-editor to get the real implementation).
function realCacheUriToFilePath(uri: string): string | null {
  const FILE_URI_PREFIX = "file://";
  if (!uri.startsWith(FILE_URI_PREFIX)) return null;
  try {
    return uri.slice(FILE_URI_PREFIX.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return uri.slice(FILE_URI_PREFIX.length);
  }
}

function realFilePathToModelUri(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `file://${encoded}`;
}

mock.module("../../../../../../src/renderer/services/editor", () => ({
  useSharedModel: () => ({
    model: mockPhase === "ready" ? {} : null,
    phase: mockPhase,
    readOnly: mockReadOnly,
    errorCode: undefined,
  }),
  openOrRevealEditor: mock(() => {}),
  saveModel: mock(() => Promise.resolve({ kind: "ok" })),
  closeEditorWithConfirm: mock(() => Promise.resolve("closed")),
  closeEditor: mock(() => {}),
  cacheUriToFilePath: realCacheUriToFilePath,
  filePathToModelUri: realFilePathToModelUri,
  isDirty: () => false,
  subscribeFileDirty: () => () => {},
  findEditorTab: mock(() => null),
  findEditorTabInGroup: mock(() => null),
  findPreviewTabInGroup: mock(() => null),
  PREVIEW_ENABLED: true,
  initializeEditorServices: mock(() => {}),
}));

// Mock pending-reveal module
// pending-reveal is intentionally NOT mocked. The real implementation returns
// null from takePendingEditorReveal when no reveal is pending (the case in
// every test below) and a real subscriber is harmless. Mocking it would
// pollute pending-reveal exports for other test files (Bun mock.module is
// process-global), notably workspace-symbol-source.test.ts.

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

const { EditorView } = await import(
  "../../../../../../src/renderer/components/workspace/content/editor-view"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EditorView — ReadOnlyBanner integration", () => {
  test("renders ReadOnlyBanner when model is readOnly", () => {
    mockReadOnly = true;
    mockPhase = "ready";

    const html = renderToStaticMarkup(
      <EditorView filePath="/external/lib/types.ts" workspaceId="ws-1" />,
    );

    expect(html).toContain("Read-only");
    expect(html).toContain("external source");
    expect(html).toContain("Reveal in Finder");
  });

  test("does NOT render ReadOnlyBanner when model is writable", () => {
    mockReadOnly = false;
    mockPhase = "ready";

    const html = renderToStaticMarkup(
      <EditorView filePath="/workspace/src/index.ts" workspaceId="ws-1" />,
    );

    expect(html).not.toContain("Read-only");
    expect(html).not.toContain("external source");
  });

  test("does NOT render ReadOnlyBanner during loading phase", () => {
    mockReadOnly = true;
    mockPhase = "loading";

    const html = renderToStaticMarkup(
      <EditorView filePath="/external/lib/types.ts" workspaceId="ws-1" />,
    );

    expect(html).not.toContain("Read-only");
  });
});
