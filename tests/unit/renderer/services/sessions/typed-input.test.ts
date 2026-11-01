import { describe, expect, it } from "bun:test";
import {
  NEWLINE_KEY,
  typedChunks,
} from "../../../../../src/renderer/services/sessions/typed-input";

describe("typedChunks", () => {
  it("types a short line as one piece", () => {
    expect(typedChunks("fix the login")).toEqual(["fix the login"]);
  });

  it("puts Ctrl+J between lines, whatever line endings the text has", () => {
    expect(typedChunks("one\ntwo\r\nthree\rfour")).toEqual([
      "one",
      NEWLINE_KEY,
      "two",
      NEWLINE_KEY,
      "three",
      NEWLINE_KEY,
      "four",
    ]);
  });

  it("keeps empty lines", () => {
    expect(typedChunks("a\n\nb")).toEqual(["a", NEWLINE_KEY, NEWLINE_KEY, "b"]);
  });

  it("splits a long line into pieces of at most 64 characters", () => {
    const chunks = typedChunks("x".repeat(150));
    expect(chunks.map((c) => c.length)).toEqual([64, 64, 22]);
    expect(chunks.join("")).toBe("x".repeat(150));
  });

  it("never splits a character outside the basic plane", () => {
    const chunks = typedChunks("😀".repeat(70));
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0] ?? "")).toHaveLength(64);
    expect(chunks.join("")).toBe("😀".repeat(70));
  });

  it("keeps Korean text whole", () => {
    expect(typedChunks("로그인 고쳐줘")).toEqual(["로그인 고쳐줘"]);
  });

  it("turns tabs into spaces and drops other control characters", () => {
    expect(typedChunks("a\tb\u001b[201~c\u0003d\u007f")).toEqual(["a    b[201~cd"]);
  });
});
