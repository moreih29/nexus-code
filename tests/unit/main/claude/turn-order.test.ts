import { expect, test } from "bun:test";
import { TurnOrder } from "../../../../src/main/features/claude/turn-order";

test("retains recent ended turns without retaining every terminal ever closed", () => {
  const turns = new TurnOrder();
  turns.isStale("workspace", "old-terminal", "user-prompt-submit", "old");
  turns.end("workspace", "old-terminal");
  expect(turns.isStale("workspace", "old-terminal", "stop", "old")).toBe(true);

  turns.isStale("workspace", "open-terminal", "user-prompt-submit", "current");
  for (let tab = 0; tab < 512; tab++) {
    turns.isStale("workspace", `tab-${tab}`, "user-prompt-submit", "prompt");
    turns.end("workspace", `tab-${tab}`);
  }

  expect(turns.acceptsResult("workspace", "old-terminal", "old")).toBe(true);
  expect(turns.isStale("workspace", "tab-511", "stop", "prompt")).toBe(true);
  expect(turns.acceptsResult("workspace", "open-terminal", "older")).toBe(false);
});
