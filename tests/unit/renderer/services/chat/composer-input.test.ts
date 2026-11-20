import { describe, expect, test } from "bun:test";
import {
  applyCompletion,
  completionAt,
  followTyped,
  splitAttachments,
} from "../../../../../src/renderer/services/chat/composer-input";

const opens = (text: string, caret = text.length, typedAt: number | null = null) =>
  completionAt(text, caret, typedAt)?.kind === "file";

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

  const cases: [string, string, boolean][] = [
    ["text start", "@", true],
    ["after a space", "이 @", true],
    ["after Korean", "이거@", true],
    ["after a paren", "(@", true],
    ["after a comma", "a,@", true],
    ["after a newline", "a\n@", true],
    ["after a letter", "abc@", false],
    ["after a digit", "a1@", false],
    ["after a dot (a.b@)", "a.b@", false],
    ["after an underscore", "a_@", false],
    ["after a hyphen", "a-@", false],
    ["after a plus", "a+@", false],
    ["after a percent", "a%@", false],
    ["email domain typed", "a@b.com", false],
    ["with a query", "이거@src/ap", true],
    ["a quoted query", '이거 @"my fi', true],
  ];
  for (const [name, text, want] of cases) {
    test(`@ ${name}: ${want ? "opens" : "stays shut"}`, () => {
      expect(opens(text)).toBe(want);
    });
  }

  test("the query and range are the token's", () => {
    expect(completionAt("이거@src", 6)).toEqual({ kind: "file", start: 2, end: 6, query: "src" });
    expect(completionAt('a @"my f', 8)).toEqual({ kind: "file", start: 2, end: 8, query: "my f" });
  });

  test("an @ typed into a sentence opens; a caret moved into a mention does not", () => {
    const text = "이 @파일 수정해 줘";
    // caret right after "@", the "@" typed there
    expect(opens(text, 3, 2)).toBe(true);
    // the same caret reached by a click or an arrow key
    expect(opens(text, 3, null)).toBe(false);
    // typed elsewhere than this token
    expect(opens(text, 3, 9)).toBe(false);
    // at the end of a mention, before a space, as before
    expect(opens("이 @a.ts 줘", 7)).toBe(true);
  });

  test("followTyped tracks the @ being typed and drops it on anything else", () => {
    const typed = followTyped("이 파일", "이 @파일", 3, null);
    expect(typed).toEqual({ start: 2, caret: 3 });
    const more = followTyped("이 @파일", "이 @s파일", 4, typed);
    expect(more).toEqual({ start: 2, caret: 4 });
    expect(followTyped("이 @s파일", "이 @파일", 3, more)).toEqual({ start: 2, caret: 3 });
    // erasing the @ itself, a paste, or a char typed elsewhere
    expect(followTyped("이 @파일", "이 파일", 2, typed)).toBeNull();
    expect(followTyped("이 @파일", "이 @파일abc", 8, typed)).toBeNull();
    expect(followTyped("이 @파일", "x이 @파일", 1, typed)).toBeNull();
  });

  test("a picked file gets a space before and after", () => {
    const text = "이거@src 다음 글";
    const completion = completionAt(text, 6, null);
    expect(completion).not.toBeNull();
    // caret before the space: the token ends at the caret
    const done = applyCompletion(text, completion!, { kind: "file", path: "src/a.ts" });
    expect(done.text).toBe("이거 @src/a.ts 다음 글");
    expect(done.caret).toBe("이거 @src/a.ts ".length);
    expect(done.open).toBeNull();
  });

  test("text right behind the token gets a space of its own", () => {
    const text = "이 @파일 줘";
    const completion = completionAt(text, 3, 2);
    const done = applyCompletion(text, completion!, { kind: "file", path: "a.ts" });
    expect(done.text).toBe("이 @a.ts 파일 줘");
    expect(done.caret).toBe("이 @a.ts ".length);
  });

  test("no extra space after a space or before a start", () => {
    const at = completionAt("@a", 2)!;
    expect(applyCompletion("@a", at, { kind: "file", path: "a.ts" })).toMatchObject({
      text: "@a.ts ",
      caret: 6,
    });
    const mid = completionAt("see @a x", 6)!;
    expect(applyCompletion("see @a x", mid, { kind: "file", path: "a.ts" }).text).toBe(
      "see @a.ts x",
    );
  });

  test("a folder is left open, with the token to follow", () => {
    const text = "이거@sr";
    const done = applyCompletion(text, completionAt(text, 5)!, { kind: "file", path: "src/" });
    expect(done.text).toBe("이거 @src/");
    expect(done.caret).toBe(8);
    expect(done.open).toEqual({ start: 3, caret: 8 });
    // and the next pick, from the open token, replaces it
    const next = completionAt(done.text, done.caret)!;
    expect(next).toMatchObject({ start: 3, query: "src/" });
    expect(applyCompletion(done.text, next, { kind: "file", path: "src/a.ts" }).text).toBe(
      "이거 @src/a.ts ",
    );
  });

  test("a path with a space is quoted", () => {
    const text = "이거@my";
    const done = applyCompletion(text, completionAt(text, 5)!, {
      kind: "file",
      path: "my docs/a b.ts",
    });
    expect(done.text).toBe('이거 @"my docs/a b.ts" ');
    const folder = applyCompletion(text, completionAt(text, 5)!, {
      kind: "file",
      path: "my docs/",
    });
    expect(folder.text).toBe('이거 @"my docs/" ');
  });

  test("a command is not given a leading space", () => {
    const done = applyCompletion("/co", completionAt("/co", 3)!, {
      kind: "command",
      name: "compact",
    });
    expect(done).toMatchObject({ text: "/compact ", caret: 9, open: null });
  });
});
