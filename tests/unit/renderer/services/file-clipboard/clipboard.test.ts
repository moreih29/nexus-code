/**
 * Tests for the file clipboard store.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { useFileClipboardStore } from "../../../../../src/renderer/services/file-clipboard/store";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";

const entry = { relPath: "a.ts", absPath: "/ws/a.ts" };

beforeEach(() => {
  useActiveStore.setState({ activeWorkspaceId: "ws-1" });
  useFileClipboardStore.getState().clear();
});

describe("file clipboard store", () => {
  it("starts empty", () => {
    expect(useFileClipboardStore.getState()).toMatchObject({
      kind: null,
      workspaceId: "",
      entries: [],
      sourceRootPath: "",
    });
  });

  it("set replaces the whole buffer", () => {
    useFileClipboardStore.getState().set("cut", "ws-1", [entry], "/ws");
    useFileClipboardStore.getState().set("copy", "ws-2", [], "/other");
    expect(useFileClipboardStore.getState()).toMatchObject({
      kind: "copy",
      workspaceId: "ws-2",
      entries: [],
      sourceRootPath: "/other",
    });
  });

  it("clear empties the buffer", () => {
    useFileClipboardStore.getState().set("cut", "ws-1", [entry], "/ws");
    useFileClipboardStore.getState().clear();
    expect(useFileClipboardStore.getState().kind).toBeNull();
    expect(useFileClipboardStore.getState().entries).toEqual([]);
  });

  it("clears when the active workspace changes", () => {
    useFileClipboardStore.getState().set("copy", "ws-1", [entry], "/ws");
    useActiveStore.setState({ activeWorkspaceId: "ws-2" });
    expect(useFileClipboardStore.getState().kind).toBeNull();
  });

  it("keeps the buffer when the active workspace is set to the same id", () => {
    useFileClipboardStore.getState().set("copy", "ws-1", [entry], "/ws");
    useActiveStore.setState({ activeWorkspaceId: "ws-1" });
    expect(useFileClipboardStore.getState().kind).toBe("copy");
  });
});
