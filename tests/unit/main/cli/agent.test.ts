/**
 * nexus agent: the subagents and `claude -p` runs of a terminal's Claude
 * session, listed, shown, waited on and stopped.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { AgentRun } from "../../../../src/shared/claude/activity";
import {
  API,
  APP,
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
} from "./fake-services";

const SESSION = "8f7b63e3-a0e6-4b44-af95-03c2697fe716";
const NOW = 1_800_000_000_000;

/** A `claude -p` run that answered. */
function printRun(extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "print-0a1b2c3d4e5f6071",
    kind: "print",
    model: "claude-haiku-4-5",
    prompt: "Summarize the README",
    start: NOW - 90_000,
    end: NOW - 30_000,
    state: "completed",
    answer: "It is an editor.",
    tools: [
      { id: "t1", name: "Read", target: "README.md", start: NOW - 80_000, end: NOW - 79_000 },
      {
        id: "t2",
        name: "Bash",
        target: "wc -l README.md",
        start: NOW - 70_000,
        end: NOW - 69_000,
        failed: true,
        error: "wc: README.md: No such file",
      },
    ],
    toolCount: 2,
    failedCount: 1,
    toolsTold: true,
    exitCode: 0,
    sessionId: SESSION,
    ...extra,
  };
}

/** A subagent at work. */
function subagent(extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "a5d1e9c07b",
    kind: "subagent",
    type: "Explore",
    description: "Find the login code",
    start: NOW - 20_000,
    state: "running",
    tools: [{ id: "t3", name: "Grep", target: "login", start: NOW - 5_000 }],
    toolCount: 1,
    failedCount: 0,
    ...extra,
  };
}

/** An app whose Claude terminal's session has these agents; nexus runs in that terminal. */
function appWith(...agents: AgentRun[]): FakeApp {
  const app = fakeApp(NOW);
  app.agents.set(`${APP}:${CLAUDE_TAB}`, agents);
  return app;
}

function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, { workspaceId: APP, tabId: CLAUDE_TAB }));
}

describe("nexus agent list", () => {
  test("lists the session's agents, a run by its Claude session id", async () => {
    const result = await nexus(appWith(subagent(), printRun()), ["agent", "list"]);
    expect(result.exitCode).toBe(0);
    const [header, first, second] = result.stdout.trimEnd().split("\n");
    expect(header).toMatch(/^ID +AGENT +STATE +SINCE +TOOLS +NOW +TASK$/);
    expect(first).toMatch(
      /^a5d1e9c0 +Explore +running +20s ago +1 +Grep login +Find the login code$/,
    );
    expect(second).toMatch(
      /^8f7b63e3 +claude -p +completed \(exit 0\) +30s ago +2 \(1 failed\) +Summarize the README$/,
    );
  });

  test("tells a run that does not tell its tools, and one without a session id by its own", async () => {
    const run = printRun({ toolsTold: undefined, sessionId: undefined, tools: [], toolCount: 0 });
    const result = await nexus(appWith(run), ["agent", "list"]);
    expect(result.stdout).toMatch(/\n0a1b2c3d +claude -p +completed \(exit 0\) +30s ago +\? /);
  });

  test("says when there are none", async () => {
    const result = await nexus(fakeApp(NOW), ["agent", "list"]);
    expect(result.stdout).toBe("No agents.\n");
  });

  test("--json gives the agents, id as shown and the app's own", async () => {
    const result = await nexus(appWith(printRun()), ["agent", "list", "--json"]);
    const [agent] = JSON.parse(result.stdout);
    expect(agent).toMatchObject({
      id: SESSION,
      agentId: "print-0a1b2c3d4e5f6071",
      answer: "It is an editor.",
    });
  });

  test("--tab looks at another terminal's session", async () => {
    const app = appWith(printRun());
    const result = await runCli(
      CLI_COMMANDS,
      contextFor(app, ["agent", "list", "--tab", CLAUDE_TAB]),
    );
    expect(result.stdout).toContain("8f7b63e3");
  });

  test("--workspace needs --tab", async () => {
    const result = await nexus(appWith(), ["agent", "list", "--workspace", API]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--workspace needs --tab");
  });
});

describe("nexus agent show", () => {
  test("shows a run by a prefix of its session id: tools, session and answer", async () => {
    const result = await nexus(appWith(subagent(), printRun()), ["agent", "show", "8f7b"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        `claude -p ${SESSION}`,
        "State:   completed (exit 0), ended 30s ago, ran 60s",
        "Model:   claude-haiku-4-5",
        `Session: ${SESSION} (claude -p --resume ${SESSION} goes on)`,
        "Prompt:  Summarize the README",
        "Tools (2, 1 failed):",
        "  ok         Read README.md",
        "  failed     Bash wc -l README.md: wc: README.md: No such file",
        "Answer:",
        "It is an editor.",
        "",
      ].join("\n"),
    );
  });

  test("shows what a run wrote between its tools, its answer apart", async () => {
    const run = printRun({
      messages: [
        { at: NOW - 85_000, text: "Reading the README\nfirst." },
        { at: NOW - 31_000, text: "It is an editor." },
      ],
    });
    const result = await nexus(appWith(run), ["agent", "show", "8f7b"]);
    expect(result.stdout).toEndWith(
      [
        "Messages (the last 1):",
        "  Reading the README first.",
        "Answer:",
        "It is an editor.",
        "",
      ].join("\n"),
    );
  });

  test("shows a codex exec run, where it is served, and how to go on with it", async () => {
    const codex = printRun({ program: "codex", model: "gpt-6-luna", endpoint: "gw.example.com" });
    const result = await nexus(appWith(codex), ["agent", "show", "8f7b"]);
    expect(result.stdout).toStartWith(
      [
        `codex exec ${SESSION}`,
        "State:   completed (exit 0), ended 30s ago, ran 60s",
        "Model:   gpt-6-luna",
        "Via:     gw.example.com",
        `Session: ${SESSION} (codex exec resume ${SESSION} goes on)`,
        "",
      ].join("\n"),
    );
    const list = await nexus(appWith(codex), ["agent", "list"]);
    expect(list.stdout).toMatch(/\n8f7b63e3 +codex exec +completed/);
  });

  test("shows a subagent by its id, its tool running", async () => {
    const result = await nexus(appWith(subagent()), ["agent", "show", "a5d1e9c07b"]);
    expect(result.stdout).toContain("Explore a5d1e9c07b\nState:   running, started 20s ago");
    expect(result.stdout).toContain("Task:    Find the login code");
    expect(result.stdout).toContain("  running    Grep login");
  });

  test("a run's full app id names it too", async () => {
    const result = await nexus(appWith(printRun()), ["agent", "show", "print-0a1b2c3d4e5f6071"]);
    expect(result.stdout).toContain(`claude -p ${SESSION}`);
  });

  test("an unknown id, or a session without agents, is an error", async () => {
    const unknown = await nexus(appWith(printRun()), ["agent", "show", "ffff"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('no agent "ffff"');
    const none = await nexus(fakeApp(NOW), ["agent", "show", "8f7b"]);
    expect(none.stderr).toContain("this terminal's session has no agents");
  });
});

describe("nexus agent wait", () => {
  test("waits until the run ends, then shows it", async () => {
    const app = appWith(printRun({ end: undefined, state: "running", answer: undefined }));
    app.time.onTick = (now) => {
      if (now < NOW + 3_000) return;
      app.agents.set(`${APP}:${CLAUDE_TAB}`, [printRun({ end: now })]);
    };
    const result = await nexus(app, ["agent", "wait", "8f7b63e3"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("State:   completed (exit 0), ended 0s ago");
    expect(result.stdout).toEndWith("Answer:\nIt is an editor.\n");
    expect(app.time.now).toBe(NOW + 3_000);
  });

  test("an agent that has ended is shown at once", async () => {
    const app = appWith(printRun());
    const result = await nexus(app, ["agent", "wait", "8f7b"]);
    expect(result.exitCode).toBe(0);
    expect(app.time.now).toBe(NOW);
  });

  test("exits 124 when the wait runs out", async () => {
    const app = appWith(subagent());
    const result = await nexus(app, ["agent", "wait", "a5d1", "--timeout", "2s"]);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toContain("Explore a5d1e9c0 was still running when the wait ran out.");
  });

  test("fails when the session goes", async () => {
    const app = appWith(subagent());
    app.time.onTick = () => app.agents.delete(`${APP}:${CLAUDE_TAB}`);
    const result = await nexus(app, ["agent", "wait", "a5d1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("a5d1 is gone");
  });
});

describe("nexus agent stop", () => {
  test("stops a running run through its watch", async () => {
    const app = appWith(printRun({ end: undefined, state: "running" }));
    app.stoppable.add("print-0a1b2c3d4e5f6071");
    const result = await nexus(app, ["agent", "stop", "8f7b"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Stopping claude -p 8f7b63e3.\n");
    expect(app.stops).toEqual(["print-0a1b2c3d4e5f6071"]);
  });

  test("refuses a subagent, a run that ended, and one the app cannot tell", async () => {
    const app = appWith(
      subagent(),
      printRun(),
      printRun({
        id: "print-ff",
        sessionId: "b0b0b0b0-0000-4000-8000-000000000000",
        end: undefined,
        state: "running",
      }),
    );
    const sub = await nexus(app, ["agent", "stop", "a5d1"]);
    expect(sub.stderr).toContain("is a subagent; it stops with its session's turn");
    const ended = await nexus(app, ["agent", "stop", "8f7b"]);
    expect(ended.stderr).toContain("has already ended (completed (exit 0))");
    const unwatched = await nexus(app, ["agent", "stop", "b0b0"]);
    expect(unwatched.stderr).toContain("cannot be stopped from the app");
    expect(app.stops).toEqual(["print-ff"]);
  });

  test("asks before stopping a run in another workspace", async () => {
    const app = fakeApp(NOW);
    app.agents.set(`${API}:${CODEX_TAB}`, [printRun({ end: undefined, state: "running" })]);
    app.stoppable.add("print-0a1b2c3d4e5f6071");
    const result = await runCli(
      CLI_COMMANDS,
      contextFor(app, ["agent", "stop", "8f7b", "--workspace", API, "--tab", CODEX_TAB]),
    );
    expect(result.exitCode).toBe(1);
    expect(app.asked).toHaveLength(1);
    expect(app.stops).toEqual([]);
  });
});
