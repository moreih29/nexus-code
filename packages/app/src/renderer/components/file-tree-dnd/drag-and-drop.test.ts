import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  FILE_TREE_DRAG_MIME,
  NEXUS_TAB_DRAG_MIME,
  dropPositionFromClientY,
  indicatorStateForDropPosition,
  readExternalEditorDropPayload,
  readTerminalTabDragDataTransfer,
  resolveDropTargetDirectory,
  resolveFileTreeMoveDestinationPath,
  serializeTerminalTabDragData,
  validateFileTreeDrop,
  writeFileTreeDragDataTransfer,
  writeTerminalTabDragDataTransfer,
} from "./drag-and-drop";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("file-tree drag-and-drop helpers", () => {
  test("resolves drop branch thresholds and over/insert/invalid indicators", () => {
    const above = dropPositionFromClientY({ clientY: 10, rowTop: 0, rowHeight: 100 });
    const over = dropPositionFromClientY({ clientY: 50, rowTop: 0, rowHeight: 100 });
    const below = dropPositionFromClientY({ clientY: 90, rowTop: 0, rowHeight: 100 });

    expect(above).toBe("insert-above");
    expect(over).toBe("over");
    expect(below).toBe("insert-below");
    expect(indicatorStateForDropPosition(above)).toBe("insert");
    expect(indicatorStateForDropPosition(over)).toBe("over");
    expect(indicatorStateForDropPosition(below)).toBe("insert");

    expect(resolveDropTargetDirectory({
      path: "src",
      kind: "directory",
      parentPath: null,
    }, over)).toEqual({
      targetDirectory: "src",
      indicatorState: "over",
    });
    expect(resolveDropTargetDirectory({
      path: "src/index.ts",
      kind: "file",
      parentPath: "src",
    }, above)).toEqual({
      targetDirectory: "src",
      indicatorState: "insert",
    });
    expect(resolveDropTargetDirectory({
      path: "src/index.ts",
      kind: "file",
      parentPath: "src",
    }, over)).toEqual({
      targetDirectory: "src",
      indicatorState: "invalid",
    });
  });

  test("blocks the four invalid drop classes: self, child, git ignored, and different workspace", () => {
    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "src", kind: "directory" }],
      targetParentPath: "src",
    })).toEqual({ valid: false, reason: "self" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "src", kind: "directory" }],
      targetParentPath: "src/nested",
    })).toEqual({ valid: false, reason: "child" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "ignored.log", kind: "file", gitStatus: "ignored" }],
      targetParentPath: null,
    })).toEqual({ valid: false, reason: "git-ignored" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: "ws_beta" as WorkspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "src/index.ts", kind: "file" }],
      targetParentPath: null,
    })).toEqual({ valid: false, reason: "different-workspace" });
  });

  test("smoke-verifies 30 internal move destinations", () => {
    for (let index = 0; index < 30; index += 1) {
      const sourcePath = `src/file-${index}.ts`;
      const targetParentPath = index % 5 === 0 ? null : `dest-${index % 3}`;

      expect(validateFileTreeDrop({
        sourceWorkspaceId: workspaceId,
        targetWorkspaceId: workspaceId,
        draggedNodes: [{ path: sourcePath, kind: "file" }],
        targetParentPath,
      })).toEqual({ valid: true, reason: null });

      expect(resolveFileTreeMoveDestinationPath({
        draggedPath: sourcePath,
        targetParentPath,
      })).toBe(targetParentPath ? `${targetParentPath}/file-${index}.ts` : `file-${index}.ts`);
    }
  });

  test("reads single workspace file drops from the existing file-tree drag writer payload", () => {
    const dataTransfer = fakeDataTransfer();
    writeFileTreeDragDataTransfer(dataTransfer, {
      workspaceId,
      path: "src/index.ts",
      kind: "file",
    });

    expect(readExternalEditorDropPayload(dataTransfer)).toEqual({
      type: "workspace-file",
      workspaceId,
      path: "src/index.ts",
      kind: "file",
    });
  });

  test("reads multi workspace file drops from the file-tree drag MIME", () => {
    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData(FILE_TREE_DRAG_MIME, JSON.stringify({
      workspaceId,
      items: [
        { path: "src/a.ts", kind: "file" },
        { path: "src/b.ts", kind: "file" },
      ],
    }));

    expect(readExternalEditorDropPayload(dataTransfer)).toEqual({
      type: "workspace-file-multi",
      workspaceId,
      items: [
        { path: "src/a.ts", kind: "file" },
        { path: "src/b.ts", kind: "file" },
      ],
    });
  });

  test("reads operating-system file drops from DataTransfer Files", () => {
    const file = { name: "notes.md", size: 42 } as File;
    const dataTransfer = fakeDataTransfer([file]);

    expect(readExternalEditorDropPayload(dataTransfer)).toEqual({
      type: "os-file",
      files: [file],
    });
  });

  test("reads operating-system file drop paths from the preload resolver when available", () => {
    const file = { name: "notes.md", size: 42 } as File;
    const dataTransfer = fakeDataTransfer([file]);

    expect(readExternalEditorDropPayload(dataTransfer, {
      resolveExternalFilePath: () => "/Users/kih/project/notes.md",
    })).toEqual({
      type: "os-file",
      files: [file],
      resolvedPaths: ["/Users/kih/project/notes.md"],
    });
  });

  test("reads terminal tab drops from the Nexus tab MIME", () => {
    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData(NEXUS_TAB_DRAG_MIME, JSON.stringify({
      type: "terminal-tab",
      workspaceId,
      tabId: "tt_ws_alpha_0001",
      source: "bottom-panel",
      sourceGroupId: "ignored_when_bottom",
    }));

    expect(readExternalEditorDropPayload(dataTransfer)).toEqual({
      type: "terminal-tab",
      workspaceId,
      tabId: "tt_ws_alpha_0001",
      source: "bottom-panel",
      sourceGroupId: "ignored_when_bottom",
    });
  });

  test("writes terminal tab drag payloads with source metadata", () => {
    const dataTransfer = fakeDataTransfer();
    const payload = {
      type: "terminal-tab" as const,
      workspaceId,
      tabId: "tt_ws_alpha_0002",
      source: "editor-group" as const,
      sourceGroupId: "group_main",
    };

    writeTerminalTabDragDataTransfer(dataTransfer, payload);

    expect(dataTransfer.getData(NEXUS_TAB_DRAG_MIME)).toBe(serializeTerminalTabDragData(payload));
    expect(dataTransfer.getData("text/plain")).toBe("tt_ws_alpha_0002");
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(readTerminalTabDragDataTransfer(dataTransfer)).toEqual(payload);
  });

  test("returns null for malformed external editor drop payloads", () => {
    const malformedFileTreeDrop = fakeDataTransfer();
    malformedFileTreeDrop.setData(FILE_TREE_DRAG_MIME, "{not json");

    const malformedTerminalDrop = fakeDataTransfer();
    malformedTerminalDrop.setData(NEXUS_TAB_DRAG_MIME, JSON.stringify({
      type: "terminal-tab",
      workspaceId,
    }));

    expect(readExternalEditorDropPayload(malformedFileTreeDrop)).toBeNull();
    expect(readExternalEditorDropPayload(malformedTerminalDrop)).toBeNull();
    expect(readExternalEditorDropPayload(fakeDataTransfer())).toBeNull();
  });
});

function fakeDataTransfer(files: File[] = []) {
  const values = new Map<string, string>();
  const types = files.length > 0 ? ["Files"] : [];

  return {
    types,
    files,
    effectAllowed: "all" as DataTransfer["effectAllowed"],
    setData(type: string, value: string) {
      if (!types.includes(type)) {
        types.push(type);
      }
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  };
}
