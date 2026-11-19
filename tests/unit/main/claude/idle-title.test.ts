import { expect, test } from "bun:test";
import {
  isClaudeIdleTitle,
  showsClaudeIdleTitle,
} from "../../../../src/main/features/claude/idle-title";

test("the Claude idle mark must be at the start of a title", () => {
  expect(isClaudeIdleTitle("✳ Claude")).toBe(true);
  expect(isClaudeIdleTitle("Claude ✳")).toBe(false);
  expect(isClaudeIdleTitle(undefined)).toBe(false);

  expect(showsClaudeIdleTitle("output\x1b]0;✳")).toBe(true);
  expect(showsClaudeIdleTitle("output\x1b]2;✳ Claude\x07")).toBe(true);
  expect(showsClaudeIdleTitle("\x1b]2;Claude ✳\x07\x1b]1;✳")).toBe(false);
});
