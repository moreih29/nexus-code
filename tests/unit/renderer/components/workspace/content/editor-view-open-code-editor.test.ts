import { describe, expect, mock, test } from "bun:test";
import { createCrossFileOpenCodeEditorOpener } from "../../../../../../src/renderer/components/workspace/content/editor-view";

interface FakeResource {
  toString(): string;
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
  test("opens file URI resources through openOrRevealEditor input", () => {
    const workspaceId = "workspace-a";
    const source = sourceEditor("file:///repo/src/source.ts");
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => workspaceId,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(source, resource("file:///repo/src/target%20file.ts"));

    expect(handled).toBe(true);
    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(openEditor).toHaveBeenCalledWith({
      workspaceId,
      filePath: "/repo/src/target file.ts",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("ignores non-file URI resources", () => {
    const source = sourceEditor("file:///repo/src/source.ts");
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => "workspace-a",
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
    const source = sourceEditor("file:///repo/src/source.ts");
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => "workspace-a",
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(source, resource("file:///repo/src/source.ts"));

    expect(handled).toBe(false);
    expect(openEditor).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("ignores requests from other editor instances", () => {
    const source = sourceEditor("file:///repo/src/source.ts");
    const otherSource = sourceEditor("file:///repo/src/other.ts");
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => "workspace-a",
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(otherSource, resource("file:///repo/src/target.ts"));

    expect(handled).toBe(false);
    expect(openEditor).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("routes external file (outside workspace) to openExternal", () => {
    const workspaceId = "workspace-a";
    const source = sourceEditor("file:///repo/src/source.ts");
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => workspaceId,
      getWorkspaceRoot: () => "/repo",
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(source, resource("file:///external/lib/util.py"));

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith({
      workspaceId,
      filePath: "/external/lib/util.py",
    });
    expect(openEditor).not.toHaveBeenCalled();
  });

  test("routes to openExternal when getWorkspaceRoot returns null", () => {
    const workspaceId = "workspace-a";
    const source = sourceEditor("file:///repo/src/source.ts");
    const openEditor = mock((_input: { workspaceId: string; filePath: string }) => {});
    const openExternal = mock((_input: { workspaceId: string; filePath: string }) => {});
    const opener = createCrossFileOpenCodeEditorOpener({
      getWorkspaceId: () => workspaceId,
      getWorkspaceRoot: () => null,
      sourceEditor: source,
      openEditor,
      openExternal,
    });

    const handled = opener.openCodeEditor(source, resource("file:///repo/src/a.ts"));

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith({ workspaceId, filePath: "/repo/src/a.ts" });
    expect(openEditor).not.toHaveBeenCalled();
  });
});
