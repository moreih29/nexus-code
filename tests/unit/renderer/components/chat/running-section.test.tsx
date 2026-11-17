import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRow } from "../../../../../src/renderer/services/chat/panel";
import { type Activity, activityOf } from "../../../../../src/renderer/services/chat/running";

const { RunningSection } = await import(
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

function render(activity: Activity, onBackground?: (id: string) => void): string {
  return renderToStaticMarkup(
    <RunningSection
      activity={activity}
      onOpen={() => {}}
      stopOf={() => () => {}}
      onBackground={onBackground}
      jobDetail={() => null}
    />,
  );
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

describe("the running section", () => {
  test("lists what runs, with a button to send what the turn waits on to the background", () => {
    const activity = activityOf({
      agents: [
        agent("sync", {
          description: "Cover the payments module",
          subagentType: "general-purpose",
        }),
        agent("async", { description: "Look into the cache", subagentType: "Explore" }),
        ...ended,
      ],
      jobs: [],
      tools: {
        sync: { id: "sync", name: "Agent", input: {}, status: "running", parentToolUseId: null },
        async: {
          id: "async",
          name: "Agent",
          input: { run_in_background: true },
          status: "done",
          parentToolUseId: null,
        },
      },
      items: [],
    });
    const html = render(activity, () => {});
    expect(html).toContain("Running");
    expect(html).toContain("Cover the payments module");
    expect(html).toContain("general-purpose");
    // An icon alone, named for what it does.
    expect(html.match(/aria-label="Send to background"/g)).toHaveLength(1);
    expect(html.match(/data-testid="running-background"/g)).toHaveLength(1);
    // What ended is one folded line: its rows are not drawn until it opens.
    expect(html).toContain("Ended 2");
    expect(html).not.toContain("Plan the refactor");
    expect(html).not.toContain("panel-ended-list");
  });

  test("with no way to send it to the background, a waited call has no button", () => {
    const activity = activityOf({
      agents: [agent("sync")],
      jobs: [],
      tools: {
        sync: { id: "sync", name: "Agent", input: {}, status: "running", parentToolUseId: null },
      },
      items: [],
    });
    expect(render(activity)).not.toContain("Send to background");
  });

  test("with nothing running, is only the line of what ended; with nothing at all, nothing", () => {
    const html = render(activityOf({ agents: ended, jobs: [], tools: {}, items: [] }));
    expect(html).toContain("Ended 2");
    expect(html).not.toContain("Running");
    expect(render({ running: [], ended: [] })).toBe("");
  });
});
