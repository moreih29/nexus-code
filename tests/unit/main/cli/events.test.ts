/**
 * nexus events: the agent sessions' state changes across the app, read from
 * a number on, and waited for when there is none yet.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliSessionEvent } from "../../../../src/shared/cli/ui";
import {
  API,
  APP,
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
  SHELL_TAB,
} from "./fake-services";

const AT = new Date(2026, 10, 7, 14, 3, 9).getTime();

async function nexus(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

function event(seq: number, extra: Partial<CliSessionEvent> = {}): CliSessionEvent {
  return {
    seq,
    at: AT,
    workspaceId: APP,
    tabId: CLAUDE_TAB,
    title: "✳ Claude Code",
    kind: "terminal",
    agent: "claude",
    from: "running",
    to: "completed",
    phase: "done",
    message: "Fixed the login bug.",
    ...extra,
  };
}

/** An app whose Claude finished (#1) and whose Codex in api went busy (#2). */
function withEvents(): FakeApp {
  const app = fakeApp();
  app.events.push(
    event(1),
    event(2, {
      workspaceId: API,
      tabId: CODEX_TAB,
      title: "codex",
      agent: "codex",
      from: null,
      to: "busy",
      phase: "running",
      message: undefined,
    }),
  );
  return app;
}

describe("events", () => {
  test("prints each change with its number, where it was, and what it said", async () => {
    const app = withEvents();
    const result = await nexus(app, ["events"]);
    expect(result.stdout).toBe(
      [
        "SEQ  TIME      TAB       WORKSPACE  TITLE          AGENT   CHANGE               MESSAGE",
        "#1   14:03:09  aaaaaaaa  app        ✳ Claude Code  claude  running → completed  Fixed the login bug.",
        "#2   14:03:09  bbbbbbbb  api        codex          codex   new → busy",
        "",
      ].join("\n"),
    );
    expect(app.uiCalls.find((c) => c.op === "events.read")?.args).toEqual({ limit: 100 });
  });

  test("--since prints those after #N; with none, says so and where the log is", async () => {
    const app = withEvents();
    const json = JSON.parse((await nexus(app, ["events", "--since", "1", "--json"])).stdout);
    expect(json.cursor).toBe(2);
    expect(json.events).toEqual([
      expect.objectContaining({ seq: 2, workspace: "api", to: "busy" }),
    ]);
    const none = await nexus(app, ["events", "--since", "2"]);
    expect(none.stdout).toBe("No changes after #2. The latest is #2.\n");
    expect(none.exitCode).toBe(0);
  });

  test("marks the caller's own session", async () => {
    const result = await nexus(withEvents(), ["events", "--json"], {
      workspaceId: APP,
      tabId: CLAUDE_TAB,
    });
    const json = JSON.parse(result.stdout);
    expect(json.events[0].current).toBe(true);
    expect(json.events[1]).not.toHaveProperty("current");
  });

  test("--wait returns with the next change as it comes", async () => {
    const app = withEvents();
    app.time.onTick = () => {
      if (app.events.length === 2) app.events.push(event(3, { from: "completed", to: "running" }));
    };
    const result = await nexus(app, ["events", "--since", "2", "--wait", "1m", "--jsonl"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([3]);
  });

  test("a wait that runs out exits 124", async () => {
    const result = await nexus(withEvents(), ["events", "--since", "2", "--wait", "2s"]);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("No changes after #2. The latest is #2.\n");
  });

  test("--workspace keeps one workspace's changes, the last --limit of them", async () => {
    const app = withEvents();
    app.events.push(event(3, { from: "completed", to: "running", phase: "running" }));
    const lines = (
      await nexus(app, ["events", "--workspace", "app", "--limit", "1", "--jsonl"])
    ).stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((e) => [e.seq, e.workspace])).toEqual([[3, "app"]]);
  });

  test("--since reads on from #N, the first --limit, so a loop misses none and hears of more", async () => {
    const app = withEvents();
    app.events.push(event(3, { from: "completed", to: "running", phase: "running" }));
    const first = await nexus(app, ["events", "--since", "0", "--limit", "2"]);
    const seqs = first.stdout.split("\n").map((line) => line.split(" ")[0]);
    expect(seqs.slice(1, 3)).toEqual(["#1", "#2"]);
    expect(first.stdout).toEndWith("\nMore after #2: nexus events --since 2\n");
    const json = JSON.parse(
      (await nexus(app, ["events", "--since", "0", "--limit", "2", "--json"])).stdout,
    );
    expect(json.more).toBe(true);
    const rest = JSON.parse((await nexus(app, ["events", "--since", "2", "--json"])).stdout);
    expect(rest.events.map((e: { seq: number }) => e.seq)).toEqual([3]);
    expect(rest).not.toHaveProperty("more");
    // One workspace's alike: #1 then #3, a page each.
    const argv = ["events", "--since", "0", "--limit", "1", "--workspace", "app", "--json"];
    const ours = JSON.parse((await nexus(app, argv)).stdout);
    expect([ours.events.map((e: { seq: number }) => e.seq), ours.more]).toEqual([[1], true]);
  });

  test("refuses a bad --since, --limit or --wait", async () => {
    const app = withEvents();
    for (const argv of [
      ["events", "--since", "-1"],
      ["events", "--since", "1.5"],
      ["events", "--limit", "0"],
      ["events", "--wait", "31m"],
      ["events", "extra"],
    ]) {
      expect((await nexus(app, argv)).exitCode).toBe(2);
    }
  });
});
