import { describe, expect, test } from "bun:test";
import { toolSummary } from "../../../../../src/renderer/components/chat/tool-row";
import type { ToolCall } from "../../../../../src/renderer/services/chat/model";

const edit = (input: Record<string, unknown>): ToolCall => ({
  id: "p:0",
  name: "Edit",
  input,
  status: "done",
  parentToolUseId: null,
});

describe("toolSummary", () => {
  test("names a file by its path from the tab's folder", () => {
    expect(toolSummary(edit({ file_path: "C:\\w\\src\\a.txt" }), "C:\\w")).toBe("src/a.txt");
  });

  test("names a file Codex moved by where it was and where it is", () => {
    const moved = edit({ file_path: "C:\\w\\lib\\b.txt", moved_from: "C:\\w\\src\\a.txt" });
    expect(toolSummary(moved, "C:\\w")).toBe("src/a.txt → lib/b.txt");
  });
});
