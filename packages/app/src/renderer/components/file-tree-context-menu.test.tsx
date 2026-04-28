import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  FileClipboardCollisionDialog,
  createFileTreeContextMenuItems,
  isImeMenuSelectEvent,
  runFileTreeContextMenuAction,
  type FileTreeContextMenuActionPayload,
  type FileTreeContextMenuTarget,
} from "./file-tree-context-menu";

const workspaceId = "ws_alpha" as WorkspaceId;
const filePayload: FileTreeContextMenuActionPayload = {
  workspaceId,
  path: "src/index.ts",
  kind: "file",
  targetDirectory: "src",
};
const fileTarget: FileTreeContextMenuTarget = {
  path: "src/index.ts",
  name: "index.ts",
  kind: "file",
  parentPath: "src",
};

describe("FileTreeContextMenu", () => {
  test("builds file, folder, and empty context item sets with disabled workflow gates", () => {
    const fileItems = createFileTreeContextMenuItems({
      kind: "file",
      canPaste: true,
      sourceControlEnabled: true,
      hasSourceControlStatus: true,
      compareEnabled: true,
    });
    const folderItems = createFileTreeContextMenuItems({
      kind: "folder",
      canPaste: false,
      sourceControlEnabled: true,
      hasSourceControlStatus: false,
    });
    const emptyItems = createFileTreeContextMenuItems({
      kind: "empty",
      canPaste: false,
      sourceControlEnabled: false,
      hasSourceControlStatus: false,
    });

    expect(fileItems.map((item) => item.id)).toEqual([
      "open",
      "open-to-side",
      "open-with-system",
      "reveal",
      "open-terminal",
      "find-folder",
      "cut",
      "copy",
      "paste",
      "copy-path",
      "copy-relative-path",
      "rename",
      "delete",
      "compare",
      "stage",
      "discard",
      "view-diff",
    ]);
    expect(fileItems.find((item) => item.id === "find-folder")?.disabled).toBe(true);
    expect(fileItems.find((item) => item.id === "compare")?.disabled).toBe(false);
    expect(fileItems.find((item) => item.id === "stage")?.disabled).toBe(false);
    expect(fileItems.find((item) => item.id === "paste")?.shortcut).toBe("⌘V");

    expect(folderItems.map((item) => item.id)).toContain("new-file");
    expect(folderItems.find((item) => item.id === "paste")?.disabled).toBe(true);
    expect(folderItems.find((item) => item.id === "stage")?.disabledReason).toContain("No source-control change");

    expect(emptyItems.map((item) => item.id)).toEqual([
      "new-file",
      "new-folder",
      "refresh",
      "reveal",
      "open-terminal",
    ]);

    expect(fileItems.map((item) => item.label)).toEqual([
      "Open",
      "Open to the Side",
      "Open With System App",
      "Reveal in Finder",
      "Open in Terminal",
      "Find in Folder",
      "Cut",
      "Copy",
      "Paste",
      "Copy Path",
      "Copy Relative Path",
      "Rename",
      "Delete",
      "Select for Compare",
      "Stage",
      "Discard Changes",
      "View Diff",
    ]);
    expect(folderItems.map((item) => item.label)).toContain("New Folder");
    expect(emptyItems.map((item) => item.label)).toEqual([
      "New File",
      "New Folder",
      "Refresh",
      "Reveal Workspace in Finder",
      "Open in Terminal",
    ]);
  });

  test("uses dynamic compare labels for Select for Compare and Compare with anchor", () => {
    expect(createFileTreeContextMenuItems({
      kind: "file",
      canPaste: false,
      sourceControlEnabled: false,
      hasSourceControlStatus: false,
      compareEnabled: true,
    }).find((item) => item.id === "compare")?.label).toBe("Select for Compare");

    expect(createFileTreeContextMenuItems({
      kind: "file",
      canPaste: false,
      sourceControlEnabled: false,
      hasSourceControlStatus: false,
      compareEnabled: true,
      compareAnchorName: "anchor.ts",
    }).find((item) => item.id === "compare")?.label).toBe("Compare with 'anchor.ts'");
  });

  test("dispatches file, folder, and empty actions and blocks IME composition menu selects", () => {
    const calls: string[] = [];
    const event = fakeMenuSelectEvent();
    const folderPayload: FileTreeContextMenuActionPayload = {
      workspaceId,
      path: "src",
      kind: "directory",
      targetDirectory: "src",
    };
    const folderTarget: FileTreeContextMenuTarget = {
      path: "src",
      name: "src",
      kind: "directory",
      parentPath: null,
    };
    const emptyPayload: FileTreeContextMenuActionPayload = {
      workspaceId,
      path: null,
      kind: "workspace",
      targetDirectory: null,
    };

    runFileTreeContextMenuAction(event, "open", filePayload, fileTarget, {
      onOpen(payload) {
        calls.push(`open:${payload.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "cut", filePayload, fileTarget, {
      onCut(items) {
        calls.push(`cut:${items[0]?.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "copy-path", filePayload, fileTarget, {
      onCopyPath(payload, pathKind) {
        calls.push(`copy-path:${pathKind}:${payload.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "open-to-side", filePayload, fileTarget, {
      onOpenToSide(payload) {
        calls.push(`open-side:${payload.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "open-with-system", filePayload, fileTarget, {
      onOpenWithSystemApp(payload) {
        calls.push(`open-system:${payload.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "reveal", filePayload, fileTarget, {
      onRevealInFinder(payload) {
        calls.push(`reveal:${payload.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "open-terminal", folderPayload, folderTarget, {
      onOpenInTerminal(payload) {
        calls.push(`terminal:${payload.targetDirectory}`);
      },
    });
    runFileTreeContextMenuAction(event, "new-file", folderPayload, folderTarget, {
      onBeginCreateFile(parentPath) {
        calls.push(`new-file:${parentPath}`);
      },
    });
    runFileTreeContextMenuAction(event, "new-folder", emptyPayload, null, {
      onBeginCreateFolder(parentPath) {
        calls.push(`new-folder:${parentPath ?? "root"}`);
      },
    });
    runFileTreeContextMenuAction(event, "refresh", emptyPayload, null, {
      onRefresh(id) {
        calls.push(`refresh:${id}`);
      },
    });
    runFileTreeContextMenuAction(event, "paste", folderPayload, folderTarget, {
      onPaste(payload) {
        calls.push(`paste:${payload.targetDirectory}`);
      },
    });
    runFileTreeContextMenuAction(event, "copy-relative-path", filePayload, fileTarget, {
      onCopyPath(payload, pathKind) {
        calls.push(`copy-path:${pathKind}:${payload.path}`);
      },
    });
    runFileTreeContextMenuAction(event, "rename", folderPayload, folderTarget, {
      onRename(path, kind) {
        calls.push(`rename:${kind}:${path}`);
      },
    });
    runFileTreeContextMenuAction(event, "delete", folderPayload, folderTarget, {
      onDelete(path, kind) {
        calls.push(`delete:${kind}:${path}`);
      },
    });
    runFileTreeContextMenuAction(event, "stage", filePayload, fileTarget, {
      onStage(path) {
        calls.push(`stage:${path}`);
      },
    });
    runFileTreeContextMenuAction(event, "discard", filePayload, fileTarget, {
      onDiscard(path) {
        calls.push(`discard:${path}`);
      },
    });
    runFileTreeContextMenuAction(event, "view-diff", filePayload, fileTarget, {
      onViewDiff(path) {
        calls.push(`view-diff:${path}`);
      },
    });
    runFileTreeContextMenuAction(event, "compare", filePayload, fileTarget, {
      onCompare(target, anchor) {
        calls.push(`compare:${anchor?.path ?? "none"}:${target.path}`);
      },
    }, {
      compareAnchor: {
        workspaceId,
        path: "src/anchor.ts",
        name: "anchor.ts",
        kind: "file",
      },
    });
    runFileTreeContextMenuAction(event, "copy", filePayload, fileTarget, {
      onCopy(items) {
        calls.push(`multi-copy:${items.map((item) => item.path).join(",")}`);
      },
    }, {
      selectedItems: [
        { workspaceId, path: "src/index.ts", kind: "file" },
        { workspaceId, path: "src/util.ts", kind: "file" },
      ],
    });

    const composingEvent = fakeMenuSelectEvent({ nativeEvent: { isComposing: true } });
    runFileTreeContextMenuAction(composingEvent, "delete", filePayload, fileTarget, {
      onDelete() {
        calls.push("delete");
      },
    });

    expect(calls).toEqual([
      "open:src/index.ts",
      "cut:src/index.ts",
      "copy-path:absolute:src/index.ts",
      "open-side:src/index.ts",
      "open-system:src/index.ts",
      "reveal:src/index.ts",
      "terminal:src",
      "new-file:src",
      "new-folder:root",
      `refresh:${workspaceId}`,
      "paste:src",
      "copy-path:relative:src/index.ts",
      "rename:directory:src",
      "delete:directory:src",
      "stage:src/index.ts",
      "discard:src/index.ts",
      "view-diff:src/index.ts",
      "compare:src/anchor.ts:src/index.ts",
      "multi-copy:src/index.ts,src/util.ts",
    ]);
    expect(isImeMenuSelectEvent(composingEvent)).toBe(true);
    expect(composingEvent.prevented).toBe(true);
  });

  test("renders collision dialog controls for cancel, keep-both, and replace resolution", () => {
    const calls: string[] = [];
    const tree = FileClipboardCollisionDialog({
      pendingCollision: {
        request: {
          type: "file-actions/clipboard/paste",
          workspaceId,
          targetDirectory: "dest",
          operation: "copy",
          entries: [{ workspaceId, path: "src/index.ts", kind: "file" }],
          conflictStrategy: "prompt",
        },
        collisions: [{ sourcePath: "src/index.ts", targetPath: "dest/index.ts", kind: "file" }],
      },
      onResolve(strategy) {
        calls.push(`resolve:${strategy}`);
      },
      onCancel() {
        calls.push("cancel");
      },
    });

    clickButtonByText(tree, "Cancel");
    clickButtonByText(tree, "Keep Both");
    clickButtonByText(tree, "Replace");

    expect(findText(tree, "Replace existing file?")).toBe(true);
    expect(findText(tree, "dest/index.ts already exists.")).toBe(true);
    expect(calls).toEqual(["cancel", "resolve:keep-both", "resolve:replace"]);
  });

  test("keeps ARIA menu and keyboard navigation delegated to shadcn/Radix primitives", () => {
    const contextMenuSource = readFileSync(new URL("./ui/context-menu.tsx", import.meta.url), "utf8");
    const fileMenuSource = readFileSync(new URL("./file-tree-context-menu.tsx", import.meta.url), "utf8");

    expect(contextMenuSource).toContain("ContextMenuPrimitive.Content");
    expect(contextMenuSource).toContain("ContextMenuPrimitive.Item");
    expect(contextMenuSource).toContain('data-slot="context-menu-content"');
    expect(contextMenuSource).toContain('data-slot="context-menu-item"');
    expect(fileMenuSource).toContain("<ContextMenuContent");
    expect(fileMenuSource).toContain("<ContextMenuItem");
    expect(fileMenuSource).toContain("isImeMenuSelectEvent(event)");
  });
});

function fakeMenuSelectEvent(options: { nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number } = {}) {
  return {
    nativeEvent: options.nativeEvent,
    keyCode: options.keyCode,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function clickButtonByText(tree: ReactNode, text: string): void {
  const button = findElementByPredicate(
    tree,
    (element) => element.type === "button" || (typeof element.type === "function" && element.type.name === "Button")
      ? textContent(element).includes(text)
      : false,
  );
  expect(button).toBeDefined();
  button?.props.onClick();
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }

    return findElementByPredicate(node.props.children, predicate);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByPredicate(child, predicate);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function findText(node: ReactNode, text: string): boolean {
  return textContent(node).includes(text);
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactElement(node)) {
    const propText = [node.props.title, node.props.description]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .join(" ");
    return `${propText} ${textContent(node.props.children)}`;
  }

  if (Array.isArray(node)) {
    return node.map((child) => textContent(child)).join("");
  }

  return "";
}
