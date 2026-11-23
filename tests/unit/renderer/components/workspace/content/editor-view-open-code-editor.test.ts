import { describe, expect, mock, test } from "bun:test";
import { createCrossFileOpenCodeEditorOpener } from "../../../../../../src/renderer/services/editor/tabs/cross-file-opener";

interface FakeResource {
  toString(): string;
}

const WORKSPACE_A = "workspace-a";

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
