import { expect, test } from "bun:test";
import { subagentConversation } from "../../../../../src/renderer/services/chat/subagent-conversation";

const agent = { id: "agent-1", prompt: "Find the bug", start: 1_000 };

const assistant = (uuid: string, content: unknown[]) => ({
  type: "assistant",
  uuid,
  timestamp: "2026-11-24T00:00:00.000Z",
  message: { id: `msg-${uuid}`, role: "assistant", content },
});

test("a subagent's transcript reads as its prompt and then what it wrote", () => {
  const read = subagentConversation(
    agent,
    [
      assistant("a", [{ type: "text", text: "Looking at the parser." }]),
      assistant("b", [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } }]),
    ],
    false,
  );
  expect(read?.items[0]).toMatchObject({ kind: "user", text: "Find the bug", at: 1_000 });
  expect(read?.items.slice(1).every((item) => item.kind === "assistant")).toBe(true);
  expect(Object.keys(read?.model.tools ?? {})).toContain("tool-1");
  expect(read?.truncated).toBe(false);
});

test("a subagent with nothing written yet has no conversation", () => {
  expect(subagentConversation(agent, [], false)).toBeNull();
});

test("a subagent without a prompt starts at what it wrote", () => {
  const read = subagentConversation(
    { ...agent, prompt: undefined },
    [assistant("a", [{ type: "text", text: "Done." }])],
    true,
  );
  expect(read?.items[0]?.kind).toBe("assistant");
  expect(read?.truncated).toBe(true);
});
