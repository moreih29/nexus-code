import { describe, expect, mock, test } from "bun:test";
// Import directly from the originating module so editor-view.tsx (and its
// transitive React/git-store dependencies) are never loaded in this test.
import { createCrossFileOpenCodeEditorOpener } from "../../../../../../src/renderer/services/editor/tabs/cross-file-opener";

interface FakeResource {
  toString(): string;
}

const WORKSPACE_A = "workspace-a";

/**
 * Build a workspace-scoped cacheUri identical in shape to what
 * monaco-converters.ts produces for LSP Location results. Tests run
 * against this shape because every Monaco model's URI is workspace-
 * scoped now (the cross-workspace cache-isolation work) — Monaco passes
 * those URIs through to the openCodeEditor hook unchanged.
 */
function cacheUri(workspaceId: string, absPath: string): string {
  return `nexus-ws://${workspaceId}${absPath}`;
}

function resource(uri: string): FakeResource {
  return {
    toString: () => uri,
  };
}

function sourceEditor(uri: string) {
  return {
    getModel: () => ({ uri: resource(uri) }),
  };
}

describe("createCrossFileOpenCodeEditorOpener", () => {
  test("opens cacheUri resources through openOrRevealEditor input", () => {
    const source = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/source.ts"));
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => WORKSPACE_A,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(
      source,
      resource(cacheUri(WORKSPACE_A, "/repo/src/target%20file.ts")),
    );

    expect(handled).toBe(true);
    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(openEditor).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      filePath: "/repo/src/target file.ts",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("ignores non-workspace URI resources", () => {
    const source = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/source.ts"));
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => WORKSPACE_A,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(source, resource("untitled:///scratch.ts"));

    expect(handled).toBe(false);
    expect(openEditor).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("leaves same-file navigation to Monaco", () => {
    const source = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/source.ts"));
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => WORKSPACE_A,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(
      source,
      resource(cacheUri(WORKSPACE_A, "/repo/src/source.ts")),
    );

    expect(handled).toBe(false);
    expect(openEditor).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("ignores requests from other editor instances", () => {
    const source = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/source.ts"));
    const otherSource = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/other.ts"));
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => WORKSPACE_A,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(
      otherSource,
      resource(cacheUri(WORKSPACE_A, "/repo/src/target.ts")),
    );

    expect(handled).toBe(false);
    expect(openEditor).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("routes external file (outside workspace) to openExternal", () => {
    const source = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/source.ts"));
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => WORKSPACE_A,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(
      source,
      resource(cacheUri(WORKSPACE_A, "/external/lib/util.py")),
    );

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      filePath: "/external/lib/util.py",
    });
    expect(openEditor).not.toHaveBeenCalled();
  });

  test("routes to openExternal when getWorkspaceRoot returns null", () => {
    const source = sourceEditor(cacheUri(WORKSPACE_A, "/repo/src/source.ts"));
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => WORKSPACE_A,
      getWorkspaceRoot: () => null,
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(
      source,
      resource(cacheUri(WORKSPACE_A, "/repo/src/a.ts")),
    );

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      filePath: "/repo/src/a.ts",
    });
    expect(openEditor).not.toHaveBeenCalled();
  });
});
