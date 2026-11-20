import { describe, expect, test } from "bun:test";
import {
  applyCompletion,
  completionAt,
  followTyped,
  matchCommands,
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
    ["in an existing query", "이거@src/ap", false],
    ["in an existing quoted query", '이거 @"my fi', false],
  ];
  for (const [name, text, want] of cases) {
    test(`@ ${name}: ${want ? "opens" : "stays shut"}`, () => {
      expect(opens(text)).toBe(want);
    });
  }

  test("the query and range are the token's", () => {
    expect(completionAt("이거@src", 6, 2)).toEqual({
      kind: "file",
      start: 2,
      end: 6,
      query: "src",
    });
    expect(completionAt('a @"my f', 8, 2)).toEqual({
      kind: "file",
      start: 2,
      end: 8,
      query: "my f",
    });
  });

  test("an @ typed into a sentence opens; a caret moved into a mention does not", () => {
    const text = "이 @파일 수정해 줘";
    // caret right after "@", the "@" typed there
    expect(opens(text, 3, 2)).toBe(true);
    // the same caret reached by a click or an arrow key
    expect(opens(text, 3, null)).toBe(false);
    // typed elsewhere than this token
    expect(opens(text, 3, 9)).toBe(false);
    // Moving to the end of an existing mention leaves the menu closed.
    expect(opens("이 @a.ts 줘", 7)).toBe(false);
    expect(opens("이 @Makefile")).toBe(false);
  });

  test("editing an existing mention reopens suggestions", () => {
    const text = "see @notes.m now";
    const caret = "see @notes.m".length;
    const typed = followTyped("see @notes.md now", text, caret, null);
    expect(typed).toEqual({ start: 4, caret });
    expect(opens(text, caret, typed?.start)).toBe(true);
  });

  test("followTyped keeps the token through an IME composing in the middle", () => {
    let typed = followTyped("이 파일", "이 @파일", 3, null);
    expect(typed).toEqual({ start: 2, caret: 3 });
    let text = "이 @파일";
    const steps: [string, number][] = [
      ["이 @ㅁ파일", 4],
      ["이 @무파일", 4],
      ["이 @문파일", 4],
      ["이 @무니파일", 5],
    ];
    for (const [next, caret] of steps) {
      typed = followTyped(text, next, caret, typed);
      expect(typed).not.toBeNull();
      expect(completionAt(next, caret, typed?.start ?? null)?.kind).toBe("file");
      text = next;
    }
    expect(typed).toEqual({ start: 2, caret: 5 });
  });

  test("followTyped drops the token when the edit leaves it", () => {
    const typed = { start: 2, caret: 4 };
    const text = "이 @a파일";
    expect(followTyped(text, "x이 @a파일", 1, typed)).toBeNull(); // before the @
    expect(followTyped(text, "이 @a파일x", 6, typed)).toBeNull(); // after the caret
    expect(followTyped(text, "이 a파일", 2, typed)).toBeNull(); // the @ erased
    expect(followTyped(text, "이 @a파일", 1, typed)).toBeNull(); // caret moved in front
    expect(followTyped(text, "이 @abc파일", 6, typed)).toEqual({ start: 2, caret: 6 }); // paste
  });

  test("a picked file gets a space before and after", () => {
    const text = "이거@src 다음 글";
    const completion = completionAt(text, 6, 2);
    expect(completion).not.toBeNull();
    // caret before the space: the token ends at the caret
    const done = applyCompletion(text, completion!, { kind: "file", path: "src/a.ts" });
    expect(done.text).toBe("이거 @src/a.ts 다음 글");
    expect(done.caret).toBe("이거 @src/a.ts ".length);
    expect(done.open).toBeNull();
    expect(opens(done.text, done.caret - 1)).toBe(false);
  });

  test("text right behind the token gets a space of its own", () => {
    const text = "이 @파일 줘";
    const completion = completionAt(text, 3, 2);
    const done = applyCompletion(text, completion!, { kind: "file", path: "a.ts" });
    expect(done.text).toBe("이 @a.ts 파일 줘");
    expect(done.caret).toBe("이 @a.ts ".length);
  });

  test("no extra space after a space or before a start", () => {
    const at = completionAt("@a", 2, 0)!;
    expect(applyCompletion("@a", at, { kind: "file", path: "a.ts" })).toMatchObject({
      text: "@a.ts ",
      caret: 6,
    });
    const mid = completionAt("see @a x", 6, 4)!;
    expect(applyCompletion("see @a x", mid, { kind: "file", path: "a.ts" }).text).toBe(
      "see @a.ts x",
    );
  });

  test("a folder is left open, with the token to follow", () => {
    const text = "이거@sr";
    const done = applyCompletion(text, completionAt(text, 5, 2)!, { kind: "file", path: "src/" });
    expect(done.text).toBe("이거 @src/");
    expect(done.caret).toBe(8);
    expect(done.open).toEqual({ start: 3, caret: 8 });
    // and the next pick, from the open token, replaces it
    const next = completionAt(done.text, done.caret, done.open?.start)!;
    expect(next).toMatchObject({ start: 3, query: "src/" });
    expect(applyCompletion(done.text, next, { kind: "file", path: "src/a.ts" }).text).toBe(
      "이거 @src/a.ts ",
    );
  });

  test("a path with a space is quoted", () => {
    const text = "이거@my";
    const done = applyCompletion(text, completionAt(text, 5, 2)!, {
      kind: "file",
      path: "my docs/a b.ts",
    });
    expect(done.text).toBe('이거 @"my docs/a b.ts" ');
    const folder = applyCompletion(text, completionAt(text, 5, 2)!, {
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

describe("matching commands", () => {
  const skills = Array.from({ length: 60 }, (_, i) => ({ name: `plug:skill${i}` }));
  const builtins = ["clear", "compact", "config", "context", "cost", "model"].map((name) => ({
    name,
    builtin: true,
  }));
  const app = [{ name: "copy", builtin: true }];
  const all = [...skills, ...builtins, ...app];
  const names = (list: { name: string }[]) => list.map((c) => c.name);

  test("a bare / lists every command, built-ins and the app's first, order kept in each group", () => {
    const got = names(matchCommands(all, ""));
    expect(got).toHaveLength(all.length);
    expect(got.slice(0, 7)).toEqual([
      "clear",
      "compact",
      "config",
      "context",
      "cost",
      "model",
      "copy",
    ]);
    expect(got.slice(7)).toEqual(names(skills));
  });

  test("a query lists starts-with built-ins, starts-with skills, then contains", () => {
    const list = [
      { name: "co:skill" },
      { name: "xx-co" },
      { name: "compact", builtin: true },
      { name: "yy-co", builtin: true },
      { name: "config", builtin: true },
    ];
    expect(names(matchCommands(list, "co"))).toEqual([
      "compact",
      "config",
      "co:skill",
      "yy-co",
      "xx-co",
    ]);
  });

  test("hidden __ commands stay out", () => {
    expect(names(matchCommands([{ name: "__x", builtin: true }, { name: "a" }], ""))).toEqual([
      "a",
    ]);
  });
});
