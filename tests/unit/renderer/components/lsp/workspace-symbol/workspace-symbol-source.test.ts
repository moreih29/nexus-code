import { describe, expect, it, mock } from "bun:test";
import { createWorkspaceSymbolPaletteSource } from "../../../../../../src/renderer/components/lsp/workspace-symbol/workspace-symbol-source";
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
  it("opens the editor with the symbol's range as selection", async () => {
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
    // Single atomic call: open + selection in one shot via revealEditorAt.
    // Earlier API split this into open + requestEditorReveal at the call
    // site; the unified seam means tests assert the contract by reading
    // openEditor's args alone — no peeking into the pending-reveal store.
    expect(openEditor).toHaveBeenCalledWith(
      { workspaceId: "ws-1", filePath: "/repo/src/greet.ts" },
      { selection: greetSymbol.location.range },
    );
  });

  it("uses Cmd+Enter side-open options together with the selection", async () => {
    const openEditor = mock(() => ({ groupId: "group", tabId: "tab" }));
    const source = createWorkspaceSymbolPaletteSource({
      workspaceId: "ws-1",
      workspaceRoot: "/repo",
      search: async () => [greetSymbol],
      openEditor,
    });

    const results = await source.search("Greet", new AbortController().signal);
    source.accept(results[0], { mode: "side" });

    expect(openEditor).toHaveBeenCalledWith(
      { workspaceId: "ws-1", filePath: "/repo/src/greet.ts" },
      {
        newSplit: { orientation: "horizontal", side: "after" },
        selection: greetSymbol.location.range,
      },
    );
  });
});
