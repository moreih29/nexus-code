/**
 * The permission requests main holds for an answer from the sessions tab:
 * what each one shows, how an answer reads to Claude Code, and when one is
 * let go of.
 */
import { describe, expect, test } from "bun:test";
import {
  alwaysOf,
  answersDialog,
  DENIED_MESSAGE,
  decisionOutput,
  PermissionAsks,
} from "../../../../src/main/features/claude/permission-asks";
import { MAIN_AGENT } from "../../../../src/main/features/claude/permission-dialogs";
import type { HookResponse } from "../../../../src/shared/claude/status";

const SUGGESTIONS = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test *" }],
    behavior: "allow",
    destination: "localSettings",
  },
];

function makeAsks(answers = true) {
  const sent: Array<{ workspaceId: string; hookId: string; response: HookResponse }> = [];
  const asks = new PermissionAsks(
    async (workspaceId, hookId, response) => {
      sent.push({ workspaceId, hookId, response });
      return answers;
    },
    () => 1_000,
  );
  return { asks, sent };
}

const payload = {
  tool_name: "Bash",
  tool_input: { command: "npm test -- --watch", description: "Run the tests" },
  permission_suggestions: SUGGESTIONS,
  cwd: "/repo",
};

describe("PermissionAsks", () => {
  test("shows a held request by its tool, target and what allowing it always lets through", () => {
    const { asks } = makeAsks();
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "call", payload);
    asks.hold("ws", "t1", "h2", "a1", "call2", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/a.ts" },
      cwd: "/repo",
    });
    asks.hold("ws", "t2", "h3", MAIN_AGENT, "call", payload);
    expect(asks.list("ws", "t1")).toEqual([
      {
        id: "h1",
        tool: "Bash",
        target: "npm test -- --watch",
        note: "Run the tests",
        always: [{ kind: "rule", rule: "Bash(npm test *)", destination: "localSettings" }],
        since: 1_000,
      },
      { id: "h2", agentId: "a1", tool: "Read", target: "a.ts", always: [], since: 1_000 },
    ]);
  });

  test("answers as the user chose, once", async () => {
    const { asks, sent } = makeAsks();
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "call", payload);
    const answered: string[] = [];
    asks.onAnswered((ask, answer) => answered.push(`${ask.tabId}:${ask.agent}:${answer}`));
    expect(await asks.answer("ws", "t1", "h1", "allowAlways")).toBe(true);
    expect(sent).toEqual([
      {
        workspaceId: "ws",
        hookId: "h1",
        response: { stdout: decisionOutput("allowAlways", SUGGESTIONS), exitCode: 0 },
      },
    ]);
    expect(answered).toEqual(["t1::allowAlways"]);
    expect(await asks.answer("ws", "t1", "h1", "allow")).toBe(false);
    expect(asks.list("ws", "t1")).toEqual([]);
  });

  test("refuses an answer it cannot give", async () => {
    const { asks, sent } = makeAsks();
    asks.hold("ws", "t1", "h1", "a1", "call", { tool_name: "Bash" });
    // Another session's, a subagent's turn to stop, and rules Claude Code did not offer.
    expect(await asks.answer("ws", "t2", "h1", "allow")).toBe(false);
    expect(await asks.answer("ws", "t1", "h1", "denyStop")).toBe(false);
    expect(await asks.answer("ws", "t1", "h1", "allowAlways")).toBe(false);
    expect(sent).toEqual([]);
    expect(asks.list("ws", "t1")).toHaveLength(1);
  });

  test("a hook that no longer waits is not answered", async () => {
    const { asks } = makeAsks(false);
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "call", payload);
    const answered: string[] = [];
    asks.onAnswered((_ask, answer) => answered.push(answer));
    expect(await asks.answer("ws", "t1", "h1", "allow")).toBe(false);
    expect(answered).toEqual([]);
    expect(asks.list("ws", "t1")).toEqual([]);
  });

  test("lets go of the requests whose dialog closed, with Claude Code's fallback", () => {
    const { asks, sent } = makeAsks();
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "c1", payload);
    asks.hold("ws", "t1", "h2", "a1", "c2", payload);
    asks.hold("ws", "t2", "h3", MAIN_AGENT, "c1", payload);
    asks.retain("ws", "t1", (agent) => agent === "a1");
    expect(sent).toEqual([{ workspaceId: "ws", hookId: "h1", response: { exitCode: 0 } }]);
    expect(asks.list("ws", "t1").map((ask) => ask.id)).toEqual(["h2"]);
    asks.gone("h2");
    asks.clearWorkspace("ws");
    expect(sent.map((s) => s.hookId)).toEqual(["h1", "h3"]);
  });
});

describe("a dialog answered in the terminal", () => {
  test("lets go of the oldest request of the session, the one on its screen", () => {
    const { asks, sent } = makeAsks();
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "c1", payload);
    asks.hold("ws", "t1", "h2", "a1", "c2", payload);
    asks.hold("ws", "t2", "h3", MAIN_AGENT, "c1", payload);
    const told: string[] = [];
    asks.onAnsweredInTerminal((ask) => told.push(`${ask.tabId}:${ask.agent}:${ask.call}`));
    asks.answeredInTerminal("ws", "t1");
    expect(sent).toEqual([{ workspaceId: "ws", hookId: "h1", response: { exitCode: 0 } }]);
    expect(told).toEqual([`t1:${MAIN_AGENT}:c1`]);
    expect(asks.list("ws", "t1").map((ask) => ask.id)).toEqual(["h2"]);
    asks.answeredInTerminal("ws", "t9");
    expect(sent).toHaveLength(1);
  });

  test.each([
    ["\r", true],
    ["1", true],
    ["3", true],
    ["\x1b[B", false],
    ["\t", false],
    ["12", false],
    ["y", false],
  ])("%j answers it: %p", (data, answers) => {
    expect(answersDialog(data)).toBe(answers);
  });
});

describe("decisionOutput", () => {
  const decision = (output: string) => JSON.parse(output).hookSpecificOutput;

  test("allows, and allows always with Claude Code's suggestions", () => {
    expect(decision(decisionOutput("allow", SUGGESTIONS))).toEqual({
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    });
    expect(decision(decisionOutput("allowAlways", SUGGESTIONS)).decision).toEqual({
      behavior: "allow",
      updatedPermissions: SUGGESTIONS,
    });
  });

  test("denies with the user's words, or a plain one, and stops the turn when asked", () => {
    expect(decision(decisionOutput("deny", [], " Use ls instead ")).decision).toEqual({
      behavior: "deny",
      message: "Use ls instead",
    });
    expect(decision(decisionOutput("denyStop", [], "")).decision).toEqual({
      behavior: "deny",
      message: DENIED_MESSAGE,
      interrupt: true,
    });
  });
});

describe("alwaysOf", () => {
  test("words rules, modes and directories, and skips what it cannot", () => {
    expect(
      alwaysOf([
        ...SUGGESTIONS,
        {
          type: "addRules",
          rules: [{ toolName: "WebFetch" }],
          behavior: "allow",
          destination: "session",
        },
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm *" }], behavior: "deny" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { type: "addDirectories", directories: ["/tmp/out"], destination: "session" },
        { type: "somethingNew" },
        "junk",
      ]),
    ).toEqual([
      { kind: "rule", rule: "Bash(npm test *)", destination: "localSettings" },
      { kind: "rule", rule: "WebFetch", destination: "session" },
      { kind: "mode", mode: "acceptEdits" },
      { kind: "directory", path: "/tmp/out" },
    ]);
  });
});
