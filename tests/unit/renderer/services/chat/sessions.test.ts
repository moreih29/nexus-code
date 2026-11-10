import { describe, expect, test } from "bun:test";
import { sessionMatches } from "../../../../../src/renderer/services/chat/sessions";

describe("sessionMatches", () => {
  const session = { title: "Fix the Build", firstPrompt: "the CI fails on lint" };

  test("every word, in the title or the first prompt, in any case", () => {
    expect(sessionMatches(session, "build lint")).toBe(true);
    expect(sessionMatches(session, "BUILD")).toBe(true);
    expect(sessionMatches(session, "build deploy")).toBe(false);
  });

  test("no words match everything", () => {
    expect(sessionMatches(session, undefined)).toBe(true);
    expect(sessionMatches(session, "   ")).toBe(true);
    expect(sessionMatches({ title: "x" }, "x")).toBe(true);
  });
});
