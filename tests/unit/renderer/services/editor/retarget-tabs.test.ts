/**
 * retargetEditorTabs — editor tabs follow a renamed or moved file, and
 * unsaved text moves with them.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
  movedFilePath,
  type RetargetEditorTabsDeps,
  retargetEditorTabs,
} from "../../../../../src/renderer/services/editor/tabs/retarget-tabs";
import type { EditorInput } from "../../../../../src/renderer/services/editor/types";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "ws-retarget";

function openTab(filePath: string, origin?: "external"): string {
  return useTabsStore.getState().createTab(WS, {
    type: "editor",
    props: { workspaceId: WS, filePath, origin },
  }).id;
}

function tab(id: string) {
  const found = useTabsStore.getState().byWorkspace[WS]?.[id];
  if (found?.type !== "editor") throw new Error(`editor tab ${id} missing`);
  return found;
}

function fakeModel(initial: string) {
  let value = initial;
  return {
    getValue: () => value,
    getFullModelRange: () => ({ full: true }),
    pushEditOperations: (_before: unknown, edits: Array<{ text: string }>) => {
      value = edits[0]?.text ?? value;
      return null;
    },
  };
}

function cleanDeps(): RetargetEditorTabsDeps {
  return {
    readUnsavedText: () => null,
    acquireModel: () => {
      throw new Error("a clean tab needs no model");
    },
    releaseModel: () => {},
  };
}

beforeEach(() => {
  useTabsStore.setState({ byWorkspace: {} });
});

describe("movedFilePath", () => {
  it("moves the file itself and anything under a moved folder", () => {
    expect(movedFilePath("/r/a.ts", "/r/a.ts", "/r/b.ts")).toBe("/r/b.ts");
    expect(movedFilePath("/r/dir/x/a.ts", "/r/dir", "/r/lib")).toBe("/r/lib/x/a.ts");
  });

  it("leaves a sibling whose name only starts the same alone", () => {
    expect(movedFilePath("/r/dir2/a.ts", "/r/dir", "/r/lib")).toBeNull();
    expect(movedFilePath("/r/a.tsx", "/r/a.ts", "/r/b.ts")).toBeNull();
  });
});

describe("retargetEditorTabs", () => {
  it("points tabs under the moved path at the new one and retitles them", async () => {
    const inside = openTab("/r/dir/a.ts");
    const outside = openTab("/r/dir2/a.ts");
    const external = openTab("/r/dir/b.ts", "external");

    await retargetEditorTabs(WS, "/r/dir", "/r/lib", cleanDeps());

    expect(tab(inside).props.filePath).toBe("/r/lib/a.ts");
    expect(tab(outside).props.filePath).toBe("/r/dir2/a.ts");
    expect(tab(external).props.filePath).toBe("/r/dir/b.ts");
  });

  it("follows the new file name in the title but keeps one the user gave", async () => {
    const plain = openTab("/r/a.ts");
    const named = openTab("/r/b.ts");
    useTabsStore.getState().renameTab(WS, named, "Mine");

    await retargetEditorTabs(WS, "/r/a.ts", "/r/c.ts", cleanDeps());
    await retargetEditorTabs(WS, "/r/b.ts", "/r/d.ts", cleanDeps());

    expect(tab(plain).title).toBe("c.ts");
    expect(tab(named).title).toBe("Mine");
    expect(tab(named).defaultTitle).toBe("d.ts");
  });

  it("carries unsaved text onto the model at the new path", async () => {
    const id = openTab("/r/a.ts");
    openTab("/r/a.ts");
    const model = fakeModel("on disk");
    const acquired: Array<{ input: EditorInput; tabPath: string }> = [];
    const released: EditorInput[] = [];

    await retargetEditorTabs(WS, "/r/a.ts", "/r/b.ts", {
      readUnsavedText: (input) => (input.filePath === "/r/a.ts" ? "edited" : null),
      acquireModel: (input) => {
        acquired.push({ input, tabPath: tab(id).props.filePath });
        return Promise.resolve({ phase: "ready", model, readOnly: false } as never);
      },
      releaseModel: (input) => {
        released.push(input);
      },
    });

    // Acquired once for both tabs, before they moved off the old path.
    expect(acquired).toEqual([
      { input: { workspaceId: WS, filePath: "/r/b.ts" }, tabPath: "/r/a.ts" },
    ]);
    expect(model.getValue()).toBe("edited");
    expect(released).toEqual([{ workspaceId: WS, filePath: "/r/b.ts" }]);
  });

  it("releases nothing when the new path fails to load", async () => {
    openTab("/r/a.ts");
    const released: EditorInput[] = [];

    await retargetEditorTabs(WS, "/r/a.ts", "/r/b.ts", {
      readUnsavedText: () => "edited",
      acquireModel: () => Promise.reject(new Error("NOT_FOUND")),
      releaseModel: (input) => {
        released.push(input);
      },
    });

    expect(released).toEqual([]);
  });
});
