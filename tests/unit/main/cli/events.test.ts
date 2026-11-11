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

  test("tells a goal set or changing, with the state or alone", async () => {
    const app = fakeApp();
    const goal = (from: string | null, status: string) => ({
      objective: "All tests pass",
      from,
      status,
    });
    app.events.push(
      event(1, { from: "idle", to: "running", phase: "running", goal: goal(null, "active") }),
      event(2, { from: "completed", to: "completed", goal: goal("active", "met") }),
    );
    const result = await nexus(app, ["events"]);
    expect(result.stdout).toContain("idle → running, goal set (active)");
    expect(result.stdout).toContain("goal active → met");
    expect(result.stdout).not.toContain("completed → completed");
  });
});
