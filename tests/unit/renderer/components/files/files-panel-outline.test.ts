import { describe, expect, test } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  innerWidth: 1400,
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const { activeEditorInputFromLayout, shouldDefaultCollapseOutline } = await import(
  "../../../../../src/renderer/components/files/files-panel"
);

describe("FilesPanel outline integration helpers", () => {
  test("defaults the outline collapsed below the 1100px breakpoint", () => {
    expect(shouldDefaultCollapseOutline(1099)).toBe(true);
    expect(shouldDefaultCollapseOutline(1100)).toBe(false);
  });

  test("derives the active editor input from the active layout group", () => {
    const layout = {
      activeGroupId: "leaf-b",
      root: {
        kind: "split" as const,
        id: "split-1",
        orientation: "horizontal" as const,
        ratio: 0.6,
        first: {
          kind: "leaf" as const,
          id: "leaf-a",
          tabIds: ["terminal-1"],
          activeTabId: "terminal-1",
        },
        second: {
          kind: "leaf" as const,
          id: "leaf-b",
          tabIds: ["editor-1"],
          activeTabId: "editor-1",
        },
      },
    };

    const input = { workspaceId: "ws-a", filePath: "/workspace/src/module.py" };

    expect(
      activeEditorInputFromLayout(layout, {
        "terminal-1": {
          id: "terminal-1",
          title: "Terminal",
          type: "terminal",
          props: { cwd: "/workspace" },
          isPreview: false,
          isPinned: false,
        },
        "editor-1": {
          id: "editor-1",
          title: "module.py",
          type: "editor",
          props: input,
          isPreview: true,
          isPinned: false,
        },
      }),
    ).toEqual(input);
  });
});
