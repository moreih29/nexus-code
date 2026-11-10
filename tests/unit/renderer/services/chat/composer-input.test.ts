import { describe, expect, test } from "bun:test";
import { splitAttachments } from "../../../../../src/renderer/services/chat/composer-input";

describe("composer completion", () => {
  test("a sent message's attachments are its last paragraph of mentions", () => {
    expect(splitAttachments('What is in it?\n\n@"/a/my note.txt" @/b/c.png')).toEqual({
      text: "What is in it?",
      files: ["/a/my note.txt", "/b/c.png"],
    });
    expect(splitAttachments("@/a/b.txt")).toEqual({ text: "", files: ["/a/b.txt"] });
    expect(splitAttachments("Look at @src/app.ts please")).toEqual({
      text: "Look at @src/app.ts please",
      files: [],
    });
  });
});
