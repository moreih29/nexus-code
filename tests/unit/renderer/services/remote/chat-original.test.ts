import { describe, expect, test } from "bun:test";
import { emptyCodexModel } from "../../../../../src/renderer/services/chat/codex/model";
import { emptyModel, type ToolCall } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { originalOf } from "../../../../../src/renderer/services/remote/chat-original";

const edit = (id: string, path: string, original: string): ToolCall =>
  ({
    id,
    name: "Edit",
    input: { file_path: path, old_string: "a", new_string: "b" },
    status: "done",
    result: {
      text: "",
      structured: { type: "update", originalFile: original, structuredPatch: [] },
    },
  }) as unknown as ToolCall;

describe("a file a chat changed, as it was before", () => {
  test("a Codex chat's, from the originals its agent took; a Windows path whatever its case", () => {
    const chat = {
      ...emptyTabState(),
      model: {
        ...emptyCodexModel(),
        originals: { "C:\\repo\\a.ts": "was\n", "/repo/new.ts": null },
      },
    };
    expect(originalOf(chat, "c:/repo/a.ts")).toBe("was\n");
    expect(originalOf(chat, "/repo/new.ts")).toBeNull();
    expect(originalOf(chat, "/repo/other.ts")).toBeUndefined();
  });

  test("a Claude chat's, from its first edit's report, its history read before its program ran too", () => {
    const chat = {
      ...emptyTabState(),
      history: { ...emptyModel(), tools: { e1: edit("e1", "/repo/a.ts", "first\n") } },
      model: { ...emptyModel(), tools: { e2: edit("e2", "/repo/a.ts", "second\n") } },
    };
    expect(originalOf(chat, "/repo/a.ts")).toBe("first\n");
    expect(originalOf(chat, "/repo/b.ts")).toBeUndefined();
  });
});
