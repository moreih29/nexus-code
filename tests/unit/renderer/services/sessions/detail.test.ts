/**
 * What the agents tab's detail panel tells of a conversation: its latest
 * calls, its subagents, its to-dos and what it runs on, from a chat tab's
 * conversation or a terminal's hook reports.
 */

import { describe, expect, test } from "bun:test";
import {
  type ChatModel,
  emptyModel,
  type ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import {
  chatDetailFacts,
  hookDetailFacts,
  NO_DETAIL,
  STEPS_SHOWN,
} from "../../../../../src/renderer/services/sessions/detail";
import type { SessionActivity } from "../../../../../src/shared/claude/activity";

function model(over: Partial<ChatModel>): ChatModel {
  return { ...emptyModel(), ...over };
}

function call(id: string, over: Partial<ToolCall>): ToolCall {
  return { id, name: "Read", input: {}, status: "done", parentToolUseId: null, ...over };
}

describe("chatDetailFacts", () => {
  test("the latest calls of the main thread, the to-dos and subagents told apart", () => {
    const facts = chatDetailFacts(
      model({
        tools: {
          a: call("a", { name: "Read", input: { file_path: "/w/session-detail.tsx" } }),
          t: call("t", {
            name: "TodoWrite",
            input: { todos: [{ content: "List rows", status: "in_progress", activeForm: "x" }] },
          }),
          g: call("g", {
            name: "Agent",
            status: "running",
            input: { description: "Find the tests", subagent_type: "Explore" },
          }),
          s: call("s", { name: "Bash", input: { command: "ls" }, parentToolUseId: "g" }),
          e: call("e", {
            name: "Edit",
            input: { file_path: "/w/model.ts" },
            result: {
              content: "",
              isError: false,
              structured: { structuredPatch: [{ lines: ["+a", "+b", "-c", " d"] }] },
            },
          }),
          b: call("b", { name: "Bash", input: { command: "bun test" }, status: "running" }),
          x: call("x", { name: "Bash", input: { command: "rm -rf /" }, status: "denied" }),
        },
      }),
    );
    expect(facts.steps).toEqual([
      { id: "a", name: "Read", target: "session-detail.tsx", status: "done" },
      { id: "e", name: "Edit", target: "model.ts", status: "done", added: 2, removed: 1 },
      { id: "b", name: "Bash", target: "bun test", status: "running" },
      { id: "x", name: "Bash", target: "rm -rf /", status: "stopped" },
    ]);
    expect(facts.todos).toEqual([{ id: "1", text: "List rows", status: "in_progress" }]);
    expect(facts.agents).toEqual([
      {
        id: "g",
        type: "Explore",
        description: "Find the tests",
        status: "running",
        print: false,
      },
    ]);
    expect(facts.files).toEqual({ count: 1, added: 2, removed: 1 });
  });

  test("only the last few calls", () => {
    const tools: Record<string, ToolCall> = {};
    for (let i = 0; i < STEPS_SHOWN + 3; i++) tools[`c${i}`] = call(`c${i}`, {});
    const facts = chatDetailFacts(model({ tools }));
    expect(facts.steps.map((step) => step.id)).toEqual(
      Array.from({ length: STEPS_SHOWN }, (_, i) => `c${i + 3}`),
    );
  });

  test("what it runs on, its last prompt and its answer so far", () => {
    const facts = chatDetailFacts(
      model({
        model: "claude-haiku-5-5",
        effort: "low",
        permissionMode: "acceptEdits",
        costUsd: 0.84,
        contextUsage: { categories: [], totalTokens: 50_000, maxTokens: 200_000 },
        items: [
          { kind: "user", id: "u", text: "Fix the regex", state: "sent" },
          {
            kind: "assistant",
            id: "m",
            blocks: [{ type: "text", text: "Fixed it." }],
          },
        ] as ChatModel["items"],
      }),
    );
    expect(facts).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
      mode: "acceptEdits",
      costUsd: 0.84,
      context: 25,
      prompt: "Fix the regex",
      answer: "Fixed it.",
      files: undefined,
    });
  });
  test("a tab opened again tells its earlier conversation until it is sent more", () => {
    const history = model({
      model: "claude-opus-5-5",
      items: [{ kind: "user", id: "u", text: "Earlier", state: "sent" }] as ChatModel["items"],
      tools: { a: call("a", { name: "Read", input: { file_path: "/w/a.ts" } }) },
    });
    const reopened = chatDetailFacts(model({ permissionMode: "default" }), history);
    expect(reopened).toMatchObject({
      prompt: "Earlier",
      model: "claude-opus-5-5",
      mode: "default",
    });
    expect(reopened.steps.map((step) => step.id)).toEqual(["a"]);
    const sent = chatDetailFacts(
      model({
        items: [{ kind: "user", id: "v", text: "Now", state: "sent" }] as ChatModel["items"],
      }),
      history,
    );
    expect(sent.prompt).toBe("Now");
    expect(sent.steps).toEqual([]);
  });
});

describe("hookDetailFacts", () => {
  const activity = (over: Partial<SessionActivity>): SessionActivity => ({
    workspaceId: "w",
    tabId: "t",
    tools: [],
    toolCount: 0,
    failedCount: 0,
    files: [],
    todos: [],
    agents: [],
    ...over,
  });

  test("nothing known, nothing told", () => {
    expect(hookDetailFacts(undefined)).toEqual(NO_DETAIL);
  });

  test("the calls by how they ended, the to-dos by how they read now", () => {
    const facts = hookDetailFacts(
      activity({
        tools: [
          { id: "a", name: "Read", target: "/w/a.ts", start: 1, end: 2 },
          { id: "b", name: "Bash", target: "go vet", start: 2, end: 3, failed: true },
          { id: "c", name: "Write", target: "/w/b.ts", start: 3, end: 4, denied: true },
          { id: "d", name: "TodoWrite", start: 4, end: 5 },
          { id: "e", name: "Bash", target: "go test ./...", start: 5 },
        ],
        todos: [
          { content: "Read", status: "completed" },
          { content: "Test", activeForm: "Testing", status: "in_progress" },
        ],
        agents: [
          {
            id: "g",
            kind: "subagent",
            type: "Explore",
            start: 1,
            state: "permissionPending",
            tools: [],
            toolCount: 0,
            failedCount: 0,
          },
          {
            id: "p",
            kind: "print",
            start: 0,
            end: 1,
            state: "completed",
            tools: [],
            toolCount: 0,
            failedCount: 0,
          },
        ],
        files: ["a.ts", "b.ts"],
      }),
    );
    expect(facts.steps.map((step) => [step.id, step.status, step.target])).toEqual([
      ["a", "done", "a.ts"],
      ["b", "failed", "go vet"],
      ["c", "stopped", "b.ts"],
      ["e", "running", "go test ./..."],
    ]);
    expect(facts.todos).toEqual([
      { id: "0", text: "Read", status: "completed" },
      { id: "1", text: "Testing", status: "in_progress" },
    ]);
    expect(facts.agents.map((agent) => [agent.id, agent.status, agent.print])).toEqual([
      ["g", "asking", false],
      ["p", "done", true],
    ]);
    expect(facts.files).toEqual({ count: 2 });
  });
});
