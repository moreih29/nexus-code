/**
 * What a row in the agents tab says beside its state: what the session
 * waits on, the call it runs, and how far it is, from a chat tab's
 * conversation or a terminal's hook reports.
 */

import { describe, expect, test } from "bun:test";
import type { SessionActivity } from "../../../../../src/shared/claude/activity";
import { type ChatModel, emptyModel } from "../../../../../src/renderer/services/chat/model";
import type { AgentSession } from "../../../../../src/renderer/services/sessions/model";
import {
  chatRowFacts,
  groupOf,
  hookRowFacts,
  inputTarget,
  NO_FACTS,
  sessionsIn,
} from "../../../../../src/renderer/services/sessions/rows";

function model(over: Partial<ChatModel>): ChatModel {
  return { ...emptyModel(), ...over };
}

const request = (toolName: string, input: Record<string, unknown>) => ({
  requestId: "r1",
  toolName,
  input,
  suggestions: [],
});

describe("inputTarget", () => {
  test("names a file by its last part, a command by its first line", () => {
    expect(inputTarget("Edit", { file_path: "/w/src/a.ts" })).toBe("a.ts");
    expect(inputTarget("Bash", { command: "bun test\necho done" })).toBe("bun test");
    expect(inputTarget("Grep", { pattern: "phaseOf" })).toBe("phaseOf");
    expect(inputTarget("Other", {})).toBeUndefined();
  });
});

describe("chatRowFacts", () => {
  test("a permission waits with its tool and what it works on", () => {
    const facts = chatRowFacts(
      model({ permissions: [request("Bash", { command: "bun run build && bun test" })] }),
    );
    expect(facts.wait).toEqual({
      kind: "permission",
      tool: "Bash",
      target: "bun run build && bun test",
    });
  });

  test("a question waits with its first question and how many there are", () => {
    const facts = chatRowFacts(
      model({
        permissions: [
          request("AskUserQuestion", {
            questions: [{ question: "Which color?" }, { question: "Which OS?" }],
          }),
        ],
      }),
    );
    expect(facts.wait).toEqual({ kind: "question", text: "Which color?", count: 2 });
  });

  test("a plan waits with its first line", () => {
    const facts = chatRowFacts(
      model({ permissions: [request("ExitPlanMode", { plan: "\n# Add a status list\n\n1. …" })] }),
    );
    expect(facts.wait).toEqual({ kind: "plan", text: "Add a status list" });
  });

  test("the running call is the latest on the main thread", () => {
    const facts = chatRowFacts(
      model({
        running: true,
        tools: {
          a: {
            id: "a",
            name: "Read",
            input: { file_path: "/w/a.ts" },
            status: "done",
            parentToolUseId: null,
          },
          b: {
            id: "b",
            name: "Edit",
            input: { file_path: "/w/agent-list.tsx" },
            status: "running",
            parentToolUseId: null,
          },
          c: {
            id: "c",
            name: "Bash",
            input: { command: "ls" },
            status: "running",
            parentToolUseId: "b",
          },
        },
      }),
    );
    expect(facts.tool).toEqual({ name: "Edit", target: "agent-list.tsx" });
    expect(facts.wait).toBeUndefined();
  });

  test("to-dos and context, when the conversation has them", () => {
    const facts = chatRowFacts(
      model({
        tools: {
          t: {
            id: "t",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "a", status: "completed", activeForm: "a" },
                { content: "b", status: "in_progress", activeForm: "b" },
                { content: "c", status: "pending", activeForm: "c" },
              ],
            },
            status: "done",
            parentToolUseId: null,
          },
        },
        contextUsage: { categories: [], totalTokens: 96_000, maxTokens: 200_000 },
      }),
    );
    expect(facts.todos).toEqual({ done: 1, total: 3 });
    expect(facts.context).toBe(48);
  });
});

describe("hookRowFacts", () => {
  const activity = (over: Partial<SessionActivity>): SessionActivity => ({
    workspaceId: "w",
    tabId: "t",
    tools: [],
    files: [],
    todos: [],
    agents: [],
    ...over,
  });

  test("nothing known, nothing said", () => {
    expect(hookRowFacts(undefined)).toEqual(NO_FACTS);
  });

  test("the session's own request before a subagent's, and the call running now", () => {
    const facts = hookRowFacts(
      activity({
        asks: [
          { id: "1", agentId: "x", tool: "Bash", target: "ls", always: [], since: 1 },
          { id: "2", tool: "Write", target: "/w/memo.txt", always: [], since: 2 },
        ],
        tools: [
          { id: "a", name: "Read", target: "/w/a.ts", start: 1, end: 2 },
          { id: "b", name: "Bash", target: "go test ./internal/...", start: 3 },
        ],
        todos: [{ content: "a", status: "completed" }],
      }),
    );
    expect(facts.wait).toEqual({ kind: "permission", tool: "Write", target: "memo.txt" });
    expect(facts.tool).toEqual({ name: "Bash", target: "go test ./internal/..." });
    expect(facts.todos).toEqual({ done: 1, total: 1 });
  });
});

describe("sessionsIn", () => {
  const session = (key: string, over: Partial<AgentSession>): AgentSession => ({
    key,
    workspaceId: "w",
    tabId: key,
    title: key,
    kind: "claude",
    agent: "claude",
    state: "idle",
    phase: "idle",
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
    ...over,
  });
  const sessions = [
    session("a", { state: "permissionPending", phase: "attention", since: 20 }),
    session("b", { state: "needsInput", phase: "attention", since: 10 }),
    session("c", { state: "completed", phase: "done", since: 5, message: "Fixed the regex" }),
    session("d", { state: "completed", phase: "done", since: 30 }),
    session("e", { state: "exited", phase: "idle" }),
    session("f", { state: "idle", phase: "idle" }),
  ];

  test("an ended terminal has a group of its own", () => {
    expect(groupOf(sessions[4] as AgentSession)).toBe("ended");
    expect(groupOf(sessions[5] as AgentSession)).toBe("idle");
  });

  test("the one waiting longest first, the latest result first", () => {
    expect(sessionsIn(sessions, "attention", "").map((s) => s.key)).toEqual(["b", "a"]);
    expect(sessionsIn(sessions, "done", "").map((s) => s.key)).toEqual(["d", "c"]);
  });

  test("a search reads the title, the prompt and the answer", () => {
    expect(sessionsIn(sessions, "done", "REGEX").map((s) => s.key)).toEqual(["c"]);
    expect(sessionsIn(sessions, "done", "nothing")).toEqual([]);
  });
});
