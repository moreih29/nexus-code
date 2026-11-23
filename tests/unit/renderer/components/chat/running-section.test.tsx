import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatItem, TaskInfo, ToolCall } from "../../../../../src/renderer/services/chat/model";
import type { AgentRow } from "../../../../../src/renderer/services/chat/panel";
import { type Activity, activityOf } from "../../../../../src/renderer/services/chat/running";

const { ActivitySections } = await import(
  "../../../../../src/renderer/components/chat/running-section"
);

function agent(toolUseId: string, over: Partial<AgentRow> = {}): AgentRow {
  return {
    toolUseId,
    description: toolUseId,
    status: "running",
    toolCount: 0,
    teammate: false,
    ...over,
  };
}

function job(taskId: string, over: Partial<TaskInfo> = {}): TaskInfo {
  return { taskId, type: "local_bash", description: taskId, status: "running", ...over };
}

function call(id: string, name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input, status: "running", parentToolUseId: null, ...over };
}

function said(at: number, ...toolUseIds: string[]): ChatItem {
  return {
    kind: "assistant",
    key: `a${at}`,
    messageId: `m${at}`,
    blocks: toolUseIds.map((toolUseId) => ({ type: "tool" as const, toolUseId })),
    at,
  };
}

function render(activity: Activity, onBackground?: (id: string) => void): string {
  return renderToStaticMarkup(
    <ActivitySections
      activity={activity}
      foldKey={`test:${Math.random()}`}
      onOpen={() => {}}
      stopOf={() => () => {}}
      onBackground={onBackground}
      jobDetail={() => null}
    />,
  );
}

function part(html: string, which: "commands" | "agents"): string {
  const at = html.indexOf(`data-testid="panel-${which}"`);
  expect(at).toBeGreaterThan(-1);
  const end = which === "commands" ? html.indexOf('data-testid="panel-agents"') : html.length;
  return html.slice(at, end);
}

function counts(html: string): [string | undefined, string | undefined] {
  return [
    /data-testid="panel-running-count">(\d+)</.exec(html)?.[1],
    /data-testid="panel-ended-count">(\d+)</.exec(html)?.[1],
  ];
}

const ended = [
  agent("old1", {
    status: "completed",
    description: "Plan the refactor",
    startedAt: 1,
    endedAt: 2,
  }),
  agent("old2", { status: "failed", description: "Trace the e2e failure" }),
];

describe("the tasks and agents sections", () => {
  test("list the commands and the subagents apart, each what runs, then a fold of what ended", () => {
    const activity = activityOf({
      agents: [
        agent("sync", {
          description: "Cover the payments module",
          subagentType: "general-purpose",
        }),
        agent("async", { description: "Look into the cache", subagentType: "Explore" }),
        ...ended,
      ],
      jobs: [
        job("dev", { description: "bun dev" }),
        job("lint", { description: "bun run lint", status: "completed" }),
      ],
      tools: {
        sync: call("sync", "Agent", {}),
        async: call("async", "Agent", { run_in_background: true }, { status: "done" }),
      },
      items: [],
    });
    const html = render(activity, () => {});
    expect(html).toContain("Tasks");
    expect(html).toContain("Agents");
    const commands = part(html, "commands");
    const agents = part(html, "agents");
    expect(commands).toContain("bun dev");
    expect(commands).not.toContain("Cover the payments module");
    expect(counts(commands)).toEqual(["1", "1"]);
    expect(agents).toContain("Cover the payments module");
    expect(agents).toContain("general-purpose");
    expect(counts(agents)).toEqual(["2", "2"]);
    expect(html.match(/aria-label="Send to background"/g)).toHaveLength(1);
    expect(html.match(/data-testid="running-background"/g)).toHaveLength(2);
    expect(html).toContain("Ended");
    expect(html).not.toContain("Plan the refactor");
    expect(html).not.toContain("bun run lint");
    expect(html).not.toContain("panel-ended-list");
  });

  test("with no way to send it to the background, a waited call has no button", () => {
    const activity = activityOf({
      agents: [agent("sync")],
      jobs: [],
      tools: { sync: call("sync", "Agent", {}) },
      items: [],
    });
    expect(render(activity)).not.toContain("Send to background");
  });

  test("are there with nothing in them: each fold a 0 that does not open", () => {
    const html = render({ running: [], ended: [] });
    for (const which of ["commands", "agents"] as const) {
      const section = part(html, which);
      expect(counts(section)).toEqual(["0", "0"]);
      expect(section.match(/aria-disabled="true"/g)).toHaveLength(2);
    }
    const quiet = part(
      render(activityOf({ agents: ended, jobs: [], tools: {}, items: [] })),
      "agents",
    );
    expect(counts(quiet)).toEqual(["0", "2"]);
  });

  test("list a command the turn waits on only once it has run three seconds", () => {
    const now = Date.now();
    const activity = activityOf({
      agents: [],
      jobs: [],
      tools: {
        quick: call("quick", "Bash", { command: "ls", description: "List the files" }),
        slow: call("slow", "Bash", { command: "bun test", description: "Run the tests" }),
      },
      items: [said(now - 5_000, "slow"), said(now, "quick")],
    });
    const commands = part(
      render(activity, () => {}),
      "commands",
    );
    expect(commands).toContain("Run the tests");
    expect(commands).not.toContain("List the files");
    expect(counts(commands)).toEqual(["1", "0"]);
  });
});
