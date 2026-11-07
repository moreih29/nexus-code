import { describe, expect, test } from "bun:test";
import { userMessageOf } from "../../../../../src/renderer/services/chat/controller";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("userMessageOf", () => {
  test("sends text as it is, for Claude to read after the tool it runs", () => {
    const { uuid, ...line } = userMessageOf("hi", []);
    expect(line).toEqual({
      type: "user",
      message: { role: "user", content: "hi" },
      parent_tool_use_id: null,
      session_id: "",
    });
    // What Claude's echo names, and what takes the message back.
    expect(uuid).toMatch(UUID);
    expect(userMessageOf("hi", []).uuid).not.toBe(uuid);
  });

  test("puts images before the text", () => {
    const image = { mediaType: "image/png", data: "AAAA" };
    expect(userMessageOf("look", [image]).message).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "look" },
      ],
    });
  });

  test("asks for the message to be read now, as a person sent it", () => {
    const line = userMessageOf("stop and look at this", [], true);
    expect(line.priority).toBe("now");
    expect(line.origin).toEqual({ kind: "human" });
    // Without one, Claude Code leaves the message for after the tool.
    expect(line.uuid).toMatch(UUID);
  });
});
