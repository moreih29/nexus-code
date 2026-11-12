/**
 * A chat row's facts are worked out once for each conversation: the lists
 * show every row again when any tab's conversation moves, and a tab whose
 * own did not move gives the same facts without walking it again.
 */
import { describe, expect, test } from "bun:test";
import { chatRowFacts } from "../../../../../src/renderer/services/agent-sessions/rows";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import type { SessionActivity } from "../../../../../src/shared/claude/activity";

describe("a chat row's facts", () => {
  test("are the same for a conversation that did not move", () => {
    const model = emptyModel();
    expect(chatRowFacts(model)).toBe(chatRowFacts(model));
  });

  test("are worked out again for a conversation that moved", () => {
    const model = emptyModel();
    const before = chatRowFacts(model);
    const moved = { ...model, contextUsage: { categories: [], totalTokens: 50, maxTokens: 100 } };
    const after = chatRowFacts(moved as typeof model);
    expect(after).not.toBe(before);
    expect(before.context).toBeUndefined();
    expect(after.context).toBe(50);
  });

  test("are worked out again when the hooks report other agents", () => {
    const model = emptyModel();
    const quiet = chatRowFacts(model);
    const activity = { agents: [] } as unknown as SessionActivity;
    expect(chatRowFacts(model, activity)).not.toBe(quiet);
    expect(chatRowFacts(model, activity)).toBe(chatRowFacts(model, activity));
  });
});
