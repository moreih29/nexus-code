import { describe, expect, test } from "bun:test";
import {
  clipTitle,
  TITLE_CHARS,
  titleOf,
} from "../../../../../src/renderer/services/chat/tab-title";

describe("a chat tab's title", () => {
  test("is the first line's first sentence", () => {
    expect(titleOf("Fix the login bug. Then add a test.\nMore here")).toBe("Fix the login bug");
    expect(titleOf("  로그인 버그 고쳐줘. 테스트도 추가해줘")).toBe("로그인 버그 고쳐줘");
    expect(titleOf("Why does it fail? It worked yesterday")).toBe("Why does it fail?");
    expect(titleOf("첫 줄\n둘째 줄")).toBe("첫 줄");
  });

  test("does not end a sentence inside a word", () => {
    expect(titleOf("Rename greet.ts to hello.ts")).toBe("Rename greet.ts to hello.ts");
    expect(titleOf("Bump to v1.2.3 and tag it")).toBe("Bump to v1.2.3 and tag it");
  });

  test("keeps an ellipsis, and a line that is only stops", () => {
    expect(titleOf("Wait... what happened")).toBe("Wait...");
    expect(titleOf("...")).toBe("...");
  });

  test("is cut to length with an ellipsis", () => {
    const long = "a".repeat(TITLE_CHARS + 20);
    const title = titleOf(long);
    expect(title.length).toBe(TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });

  test("a given title is cut, on one line", () => {
    expect(clipTitle("  Greet  name\tdefault ")).toBe("Greet name default");
    expect(clipTitle("b".repeat(TITLE_CHARS))).toBe("b".repeat(TITLE_CHARS));
    expect(clipTitle("b".repeat(TITLE_CHARS + 1)).length).toBe(TITLE_CHARS);
  });
});
