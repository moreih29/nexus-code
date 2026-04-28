import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  createFileTreeMultiSelectStore,
  fileTreeSelectionRange,
} from "./file-tree-multi-select-store";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("file-tree-multi-select-store", () => {
  test("toggles paths and tracks the last range anchor", () => {
    const store = createFileTreeMultiSelectStore();

    store.getState().toggleSelect("src/index.ts");
    expect(Array.from(store.getState().selectedPaths)).toEqual(["src/index.ts"]);
    expect(store.getState().lastAnchor).toBe("src/index.ts");

    store.getState().toggleSelect("src/index.ts");
    expect(Array.from(store.getState().selectedPaths)).toEqual([]);
    expect(store.getState().lastAnchor).toBe("src/index.ts");
  });

  test("selects inclusive ranges from visible file tree paths", () => {
    const store = createFileTreeMultiSelectStore();
    const visiblePaths = ["src", "src/index.ts", "README.md", "package.json"];

    store.getState().rangeSelect("src/index.ts", "package.json", visiblePaths);

    expect(Array.from(store.getState().selectedPaths)).toEqual([
      "src/index.ts",
      "README.md",
      "package.json",
    ]);
    expect(store.getState().lastAnchor).toBe("src/index.ts");
    expect(fileTreeSelectionRange("missing", "README.md", visiblePaths)).toEqual(["README.md"]);
  });

  test("selectAll and clearSelect operate on the current folder path list", () => {
    const store = createFileTreeMultiSelectStore();

    store.getState().selectAll(["src/index.ts", "src/util.ts"]);
    expect(Array.from(store.getState().selectedPaths)).toEqual(["src/index.ts", "src/util.ts"]);
    expect(store.getState().lastAnchor).toBe("src/index.ts");

    store.getState().clearSelect();
    expect(store.getState().selectedPaths.size).toBe(0);
    expect(store.getState().lastAnchor).toBeNull();
  });

  test("stores and clears compare anchor independently from selection", () => {
    const store = createFileTreeMultiSelectStore();

    store.getState().toggleSelect("src/index.ts");
    store.getState().setCompareAnchor({
      workspaceId,
      path: "src/index.ts",
      name: "index.ts",
      kind: "file",
    });
    store.getState().clearSelect();

    expect(store.getState().compareAnchor).toMatchObject({ path: "src/index.ts", name: "index.ts" });
    expect(store.getState().selectedPaths.size).toBe(0);

    store.getState().clearCompareAnchor();
    expect(store.getState().compareAnchor).toBeNull();
  });
});
