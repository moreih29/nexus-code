import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  dropPositionFromClientY,
  indicatorStateForDropPosition,
  resolveDropTargetDirectory,
  resolveFileTreeMoveDestinationPath,
  validateFileTreeDrop,
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
});
