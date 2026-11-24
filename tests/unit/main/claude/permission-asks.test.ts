import { describe, expect, mock, test } from "bun:test";
import { answerHook } from "../../../../src/main/features/claude/hook-handler";
import {
  alwaysOf,
  answersDialog,
  DENIED_MESSAGE,
  DISMISS_WINDOW_MS,
  decisionOutput,
  PermissionAsks,
  type Schedule,
  TERMINAL_RELEASE_MS,
} from "../../../../src/main/features/claude/permission-asks";
import { MAIN_AGENT } from "../../../../src/main/features/claude/permission-dialogs";
import type { AgentChannel } from "../../../../src/main/infra/agent/channel";
import type { HookResponse } from "../../../../src/shared/claude/status";

const SUGGESTIONS = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test *" }],
    behavior: "allow",
    destination: "localSettings",
  },
];

function manualTimers() {
  const pending = new Set<{ run: () => void; ms: number }>();
  const schedule: Schedule = (run, ms) => {
    const entry = { run, ms };
    pending.add(entry);
    return () => {
      pending.delete(entry);
    };
  };
  const flush = () => {
    for (const entry of [...pending]) {
      pending.delete(entry);
      entry.run();
    }
  };
  return { schedule, flush, pending };
}

function makeAsks(answers = true, schedule?: Schedule) {
  const sent: Array<{ workspaceId: string; hookId: string; response: HookResponse }> = [];
  const asks = new PermissionAsks(
    async (workspaceId, hookId, response) => {
      sent.push({ workspaceId, hookId, response });
      return answers ? "answered" : "gone";
    },
    () => 1_000,
    schedule,
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

  test("an unavailable agent leaves its request available for a retry", async () => {
    const call = mock(async () => ({}));
    let channel: AgentChannel | null = null;
    const provider = { tryGetAgentChannel: async () => channel };
    const asks = new PermissionAsks((workspaceId, id, response) =>
      answerHook(provider, workspaceId, id, response),
    );
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "call", payload);
    expect(await asks.answer("ws", "t1", "h1", "deny")).toBe(false);
    expect(asks.list("ws", "t1").map(({ id }) => id)).toEqual(["h1"]);

    channel = { call } as unknown as AgentChannel;
    expect(await asks.answer("ws", "t1", "h1", "deny")).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(asks.list("ws", "t1")).toEqual([]);
  });

  test("only one answer can be in flight for the same hook", async () => {
    const receipt = Promise.withResolvers<"answered">();
    const respond = mock(() => receipt.promise);
    const asks = new PermissionAsks(respond);
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "call", payload);
    const pending = asks.answer("ws", "t1", "h1", "deny");
    expect(await asks.answer("ws", "t1", "h1", "deny")).toBe(false);
    expect(respond).toHaveBeenCalledTimes(1);
    receipt.resolve("answered");
    expect(await pending).toBe(true);
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
  test("closes the oldest request of the session, the one on its screen, and lets go of its hook a while later", () => {
    const timers = manualTimers();
    const { asks, sent } = makeAsks(true, timers.schedule);
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "c1", payload);
    asks.hold("ws", "t1", "h2", "a1", "c2", payload);
    asks.hold("ws", "t2", "h3", MAIN_AGENT, "c1", payload);
    const told: string[] = [];
    asks.onAnsweredInTerminal((ask) => told.push(`${ask.tabId}:${ask.agent}:${ask.call}`));
    asks.answeredInTerminal("ws", "t1");
    expect(told).toEqual([`t1:${MAIN_AGENT}:c1`]);
    expect(asks.list("ws", "t1").map((ask) => ask.id)).toEqual(["h2"]);
    expect(sent).toEqual([]);
    expect([...timers.pending].map((entry) => entry.ms)).toEqual([TERMINAL_RELEASE_MS]);
    timers.flush();
    expect(sent).toEqual([{ workspaceId: "ws", hookId: "h1", response: { exitCode: 0 } }]);
    asks.answeredInTerminal("ws", "t9");
    timers.flush();
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

describe("a dialog dismissed by a key in the terminal", () => {
  function escapable() {
    let now = 1_000;
    const sent: string[] = [];
    const timers = manualTimers();
    const asks = new PermissionAsks(
      async (_workspaceId, hookId) => {
        sent.push(hookId);
        return "answered";
      },
      () => now,
      timers.schedule,
    );
    const dismissed: string[] = [];
    asks.onDismissedInTerminal((ask) => dismissed.push(`${ask.tabId}:${ask.agent}:${ask.call}`));
    asks.hold("ws", "t1", "h1", MAIN_AGENT, "c1", payload);
    return {
      asks,
      sent,
      dismissed,
      flush: timers.flush,
      later: (ms: number) => {
        now += ms;
      },
    };
  }

  test("the request Claude Code drops right after Esc reads as dismissed, unanswered", () => {
    const { asks, sent, dismissed, later } = escapable();
    asks.noteTerminalInput("ws", "t1", "\x1b");
    later(200);
    asks.gone("h1");
    expect(dismissed).toEqual([`t1:${MAIN_AGENT}:c1`]);
    expect(asks.list("ws", "t1")).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("one Esc dismisses every request Claude Code drops with it", () => {
    const { asks, dismissed } = escapable();
    asks.hold("ws", "t1", "h2", "a1", "c2", payload);
    asks.noteTerminalInput("ws", "t1", "\x1b");
    asks.gone("h2");
    asks.gone("h1");
    expect(dismissed).toEqual(["t1:a1:c2", `t1:${MAIN_AGENT}:c1`]);
  });

  test("a focus report after Esc keeps it", () => {
    const { asks, dismissed } = escapable();
    asks.noteTerminalInput("ws", "t1", "\x1b");
    asks.noteTerminalInput("ws", "t1", "\x1b[O");
    asks.gone("h1");
    expect(dismissed).toHaveLength(1);
  });

  test.each([
    ["no Esc", [] as string[], 0],
    ["a key after Esc", ["\x1b", "\x1b[Z"], 0],
    ["Esc in another tab", ["other"], 0],
    ["Esc too long before", ["\x1b"], DISMISS_WINDOW_MS + 1],
  ])("a request dropped after %s is only forgotten", (_name, keys, wait) => {
    const { asks, dismissed, later } = escapable();
    for (const key of keys) {
      if (key === "other") {
        asks.hold("ws", "t2", "h9", MAIN_AGENT, "c1", payload);
        asks.noteTerminalInput("ws", "t2", "\x1b");
      } else {
        asks.noteTerminalInput("ws", "t1", key);
      }
    }
    later(wait);
    asks.gone("h1");
    expect(dismissed).toEqual([]);
    expect(asks.list("ws", "t1")).toEqual([]);
  });

  test("Esc with nothing held arms nothing for a later request", () => {
    const { asks, dismissed } = escapable();
    asks.gone("h1");
    asks.noteTerminalInput("ws", "t1", "\x1b");
    asks.hold("ws", "t1", "h2", MAIN_AGENT, "c2", payload);
    asks.gone("h2");
    expect(dismissed).toEqual([]);
  });

  test("a request Claude Code drops right after a numbered pick reads as dismissed, unanswered", () => {
    const { asks, sent, dismissed, flush } = escapable();
    const told: string[] = [];
    asks.onAnsweredInTerminal((ask) => told.push(ask.call ?? ""));
    asks.noteTerminalInput("ws", "t1", "3");
    expect(told).toEqual(["c1"]);
    asks.gone("h1");
    flush();
    expect(dismissed).toEqual([`t1:${MAIN_AGENT}:c1`]);
    expect(sent).toEqual([]);
  });

  test("Enter on the dialog counts as its pick too", () => {
    const { asks, dismissed } = escapable();
    asks.noteTerminalInput("ws", "t1", "\x1b[B");
    asks.noteTerminalInput("ws", "t1", "\r");
    asks.gone("h1");
    expect(dismissed).toHaveLength(1);
  });

  test("a pick whose hook Claude Code keeps is let go after a while and never dismissed", () => {
    const { asks, sent, dismissed, flush } = escapable();
    asks.noteTerminalInput("ws", "t1", "1");
    flush();
    expect(sent).toEqual(["h1"]);
    asks.gone("h1");
    expect(dismissed).toEqual([]);
  });

  test("a cleared tab lets go at once of what it was about to", () => {
    const { asks, sent, flush } = escapable();
    asks.noteTerminalInput("ws", "t1", "1");
    asks.clear("ws", "t1");
    expect(sent).toEqual(["h1"]);
    flush();
    expect(sent).toEqual(["h1"]);
  });

  test("a cleared tab forgets its Esc", () => {
    const { asks, dismissed } = escapable();
    asks.noteTerminalInput("ws", "t1", "\x1b");
    asks.clearWorkspace("ws");
    asks.hold("ws", "t1", "h2", MAIN_AGENT, "c2", payload);
    asks.gone("h2");
    expect(dismissed).toEqual([]);
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
