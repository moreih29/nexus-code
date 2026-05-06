import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  __resetWorkspaceSymbolRegistryForTests,
  registerWorkspaceSymbolProvider,
  searchWorkspaceSymbols,
  type WorkspaceSymbolEntry,
} from "../../../../../src/renderer/services/lsp/workspace-symbol-registry";

const range = {
  startLineNumber: 1,
  startColumn: 2,
  endLineNumber: 1,
  endColumn: 7,
};

function symbol(name: string, uri = "file:///repo/src/greet.ts"): WorkspaceSymbolEntry {
  return { name, kind: 11, location: { uri, range } };
}

afterEach(() => {
  __resetWorkspaceSymbolRegistryForTests();
});

describe("workspace-symbol-registry", () => {
  it("calls two providers and concatenates their results", async () => {
    const first = mock(async () => [symbol("Greet")]);
    const second = mock(async () => [symbol("Greeter", "file:///repo/src/greeter.ts")]);

    registerWorkspaceSymbolProvider({ id: "first", provideWorkspaceSymbols: first });
    registerWorkspaceSymbolProvider({ id: "second", provideWorkspaceSymbols: second });

    const results = await searchWorkspaceSymbols({ workspaceId: "ws-1", query: "Gre" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(results.map((item) => item.name)).toEqual(["Greet", "Greeter"]);
  });

  it("dedupes by uri, range, and name", async () => {
    registerWorkspaceSymbolProvider({
      id: "first",
      provideWorkspaceSymbols: async () => [symbol("Greet"), symbol("Greet")],
    });
    registerWorkspaceSymbolProvider({
      id: "second",
      provideWorkspaceSymbols: async () => [symbol("Greet"), symbol("GreetOther")],
    });

    const results = await searchWorkspaceSymbols({ workspaceId: "ws-1", query: "Gre" });

    expect(results.map((item) => item.name)).toEqual(["Greet", "GreetOther"]);
  });

  it("keeps distinct symbols whose fields would collide with delimiter-joined keys", async () => {
    const first = symbol("3:4:5:name", "file:///repo/a:1");
    first.location.range = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 5,
    };
    const second = symbol("name", "file:///repo/a:1:2");
    second.location.range = {
      startLineNumber: 3,
      startColumn: 4,
      endLineNumber: 5,
      endColumn: 3,
    };
    registerWorkspaceSymbolProvider({
      id: "edge",
      provideWorkspaceSymbols: async () => [first, second],
    });

    const results = await searchWorkspaceSymbols({ workspaceId: "ws-1", query: "name" });

    expect(results).toHaveLength(2);
  });

  it("allows partial provider failure", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    registerWorkspaceSymbolProvider({
      id: "ok",
      provideWorkspaceSymbols: async () => [symbol("Greet")],
    });
    registerWorkspaceSymbolProvider({
      id: "broken",
      provideWorkspaceSymbols: async () => {
        throw new Error("boom");
      },
    });

    const results = await searchWorkspaceSymbols({ workspaceId: "ws-1", query: "Gre" });

    expect(results.map((item) => item.name)).toEqual(["Greet"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("unregister cleanup removes the provider", async () => {
    const provider = mock(async () => [symbol("Greet")]);
    const unregister = registerWorkspaceSymbolProvider({
      id: "one",
      provideWorkspaceSymbols: provider,
    });
    unregister();

    const results = await searchWorkspaceSymbols({ workspaceId: "ws-1", query: "Gre" });

    expect(results).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it("short-circuits empty queries without provider calls", async () => {
    const provider = mock(async () => [symbol("Greet")]);
    registerWorkspaceSymbolProvider({ id: "one", provideWorkspaceSymbols: provider });

    const results = await searchWorkspaceSymbols({ workspaceId: "ws-1", query: "   " });

    expect(results).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });
});
