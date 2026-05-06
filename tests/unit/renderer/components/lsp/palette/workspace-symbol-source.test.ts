import { describe, expect, it, mock } from "bun:test";
import { createWorkspaceSymbolPaletteSource } from "../../../../../../src/renderer/components/lsp/palette/workspace-symbol-source";
import {
  __resetPendingEditorRevealsForTests,
  takePendingEditorReveal,
} from "../../../../../../src/renderer/services/editor/pending-reveal";
import type { WorkspaceSymbolEntry } from "../../../../../../src/renderer/services/lsp/workspace-symbol-registry";

const greetSymbol: WorkspaceSymbolEntry = {
  name: "Greet",
  kind: 11,
  containerName: "greetings",
  location: {
    uri: "file:///repo/src/greet.ts",
    range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 6 },
  },
};

describe("workspace symbol palette source", () => {
  it("maps query Greet to open/reveal editor", async () => {
    __resetPendingEditorRevealsForTests();
    const openEditor = mock(() => ({ groupId: "group", tabId: "tab" }));
    const source = createWorkspaceSymbolPaletteSource({
      workspaceId: "ws-1",
      workspaceRoot: "/repo",
      search: async () => [greetSymbol],
      openEditor,
    });

    const results = await source.search("Greet", new AbortController().signal);
    source.accept(results[0], { mode: "default" });

    expect(results[0]).toMatchObject({
      label: "Greet",
      detail: "greetings · src/greet.ts:3:1",
      filePath: "/repo/src/greet.ts",
    });
    expect(openEditor).toHaveBeenCalledWith(
      { workspaceId: "ws-1", filePath: "/repo/src/greet.ts" },
      undefined,
    );
    expect(
      takePendingEditorReveal({ workspaceId: "ws-1", filePath: "/repo/src/greet.ts" }),
    ).toEqual(greetSymbol.location.range);
  });

  it("uses Cmd+Enter side-open options", async () => {
    const openEditor = mock(() => ({ groupId: "group", tabId: "tab" }));
    const source = createWorkspaceSymbolPaletteSource({
      workspaceId: "ws-1",
      workspaceRoot: "/repo",
      search: async () => [greetSymbol],
      openEditor,
      revealEditor: () => {},
    });

    const results = await source.search("Greet", new AbortController().signal);
    source.accept(results[0], { mode: "side" });

    expect(openEditor).toHaveBeenCalledWith(
      { workspaceId: "ws-1", filePath: "/repo/src/greet.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );
  });
});
