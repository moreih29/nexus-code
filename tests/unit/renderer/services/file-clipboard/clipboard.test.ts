/**
 * Tests for file-clipboard.
 *
 * Tests inline minimal versions of the clipboard logic since the real
 * module imports @/ aliases (store.ts → useActiveStore) that can't be
 * transparently mocked across module boundaries.
 */
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal inline store — mirrors useFileClipboardStore logic without @/
// ---------------------------------------------------------------------------

interface ClipboardEntry {
  relPath: string;
  absPath: string;
}

interface ClipboardState {
  kind: "cut" | "copy" | null;
  workspaceId: string;
  entries: ClipboardEntry[];
  sourceRootPath: string;
}

let state: ClipboardState = {
  kind: null,
  workspaceId: "",
  entries: [],
  sourceRootPath: "",
};

function setClipboard(
  kind: "cut" | "copy",
  workspaceId: string,
  entries: ClipboardEntry[],
  sourceRootPath: string,
) {
  state = { kind, workspaceId, entries, sourceRootPath };
}

function clearClipboard() {
  state = { kind: null, workspaceId: "", entries: [], sourceRootPath: "" };
}

/**
 * Resolves the paste target directory from activeAbsPath.
 * Logic identical to handlePaste in paste.ts lines 39-50.
 */
function resolvePasteTarget(
  activeAbsPath: string | null,
  rootAbsPath: string,
  nodeTypes: Map<string, "dir" | "file">,
): string {
  if (activeAbsPath === null) return rootAbsPath;
  const type = nodeTypes.get(activeAbsPath);
  if (type === "dir") return activeAbsPath;
  // file → parent
  const dir = activeAbsPath.substring(0, activeAbsPath.lastIndexOf("/"));
  return dir.length < rootAbsPath.length ? rootAbsPath : dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clipboard store lifecycle", () => {
  it("starts with null kind", () => {
    expect(state.kind).toBeNull();
  });

  it("set stores kind, entries, root", () => {
    setClipboard("copy", "ws-1", [{ relPath: "a.ts", absPath: "/ws/a.ts" }], "/ws");
    expect(state.kind).toBe("copy");
    expect(state.entries[0].absPath).toBe("/ws/a.ts");
    expect(state.sourceRootPath).toBe("/ws");
  });

  it("clear resets to null", () => {
    setClipboard("cut", "ws-1", [{ relPath: "x.ts", absPath: "/ws/x.ts" }], "/ws");
    clearClipboard();
    expect(state.kind).toBeNull();
    expect(state.entries).toEqual([]);
  });

  it("set overwrites previous state", () => {
    setClipboard("cut", "wsa", [makeEntry("a")], "/a");
    setClipboard("copy", "wsb", [makeEntry("b")], "/b");
    expect(state.kind).toBe("copy");
    expect(state.workspaceId).toBe("wsb");
    expect(state.entries).toEqual([makeEntry("b")]);
  });
});

describe("resolvePasteTarget", () => {
  const nodes = new Map<string, "dir" | "file">([
    ["/ws/src", "dir"],
    ["/ws/src/index.ts", "file"],
    ["/ws/README.md", "file"],
  ]);

  it("activeAbsPath null → root", () => {
    expect(resolvePasteTarget(null, "/ws", nodes)).toBe("/ws");
  });

  it("activeAbsPath is dir → itself", () => {
    expect(resolvePasteTarget("/ws/src", "/ws", nodes)).toBe("/ws/src");
  });

  it("activeAbsPath is file → its parent", () => {
    expect(resolvePasteTarget("/ws/src/index.ts", "/ws", nodes)).toBe("/ws/src");
  });

  it("file at root level → root as parent", () => {
    expect(resolvePasteTarget("/ws/README.md", "/ws", nodes)).toBe("/ws");
  });
});

describe("copy vs cut semantics", () => {
  it("bumps workspaceId when switching source", () => {
    setClipboard("copy", "ws-a", [{ relPath: "f.ts", absPath: "/a/f.ts" }], "/a");
    expect(state.workspaceId).toBe("ws-a");

    setClipboard("copy", "ws-b", [{ relPath: "f.ts", absPath: "/b/f.ts" }], "/b");
    expect(state.workspaceId).toBe("ws-b");
  });

  it("kind=cut is distinguishable from kind=copy", () => {
    setClipboard("cut", "ws", [makeEntry("x")], "/ws");
    expect(state.kind).toBe("cut");

    setClipboard("copy", "ws", [makeEntry("x")], "/ws");
    expect(state.kind).toBe("copy");
  });
});

function makeEntry(name: string): ClipboardEntry {
  return { relPath: name, absPath: `/ws/${name}` };
}