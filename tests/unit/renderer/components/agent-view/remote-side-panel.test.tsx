import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatPanel } from "../../../../../packages/remote-protocol/src/view";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import type { RemoteTarget } from "../../../../../src/renderer/state/stores/remote-view";

const { RemoteSidePanel, remoteAgentsOf, remotePanelPartOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-side-panel"
);
const { remoteSummaryCounts } = await import(
  "../../../../../src/renderer/components/agent-view/remote-pane"
);
const { usageMeterLabel } = await import("../../../../../src/renderer/components/chat/usage-line");
const { RemoteProfileChip } = await import(
  "../../../../../src/renderer/components/agent-view/remote-profile-chip"
);

const target: RemoteTarget = {
  deviceId: "d2",
  deviceName: "Work PC",
  workspaceId: "w1",
  tabId: "t1",
  kind: "claude",
  title: "Fix the build",
  path: "/src/api",
  profile: "work",
};

const panel = (over: Partial<ChatPanel>): ChatPanel => ({
  todos: [],
  tasks: [],
  agents: [],
  changedFiles: [],
  context: null,
  goal: null,
  ...over,
});

describe("another computer's chat's side panel", () => {
  test("lists the computer's subagents with what the conversation shown tells of them", () => {
    const model = {
      ...emptyModel(),
      tools: {
        a1: {
          id: "a1",
          name: "Agent",
          input: { description: "Read the tests", subagent_type: "Explore" },
          status: "running" as const,
          parentToolUseId: null,
        },
        a2: {
          id: "a2",
          name: "Agent",
          input: { description: "Not listed yet" },
          status: "running" as const,
          parentToolUseId: null,
        },
      },
    };
    const rows = remoteAgentsOf(
      panel({
        agents: [
          { toolUseId: "a1", description: "", status: "completed", startedAt: 1, endedAt: 2 },
          { toolUseId: "a3", description: "Elsewhere", status: "weird" },
        ],
      }),
      model,
    );
    expect(rows.map((row) => [row.toolUseId, row.status])).toEqual([
      ["a1", "completed"],
      ["a3", "stopped"],
      ["a2", "running"],
    ]);
    // The list's empty description takes the conversation's.
    expect(rows[0]?.description).toBe("Read the tests");
    expect(rows[0]?.endedAt).toBe(2);
  });

  test("counts what its one-line summary tells, as a chat here's does", () => {
    const counts = remoteSummaryCounts(
      panel({
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
        tasks: [
          { taskId: "j1", type: "local_bash", description: "dev", status: "running" },
          { taskId: "j2", type: "local_bash", description: "old", status: "completed" },
        ],
        context: { usedTokens: 50_000, maxTokens: 200_000 },
      }),
      [
        { toolUseId: "a", description: "", status: "running", toolCount: 0, teammate: false },
        { toolUseId: "b", description: "", status: "completed", toolCount: 0, teammate: false },
      ],
    );
    expect(counts).toEqual({
      agents: 1,
      jobs: 1,
      todos: { done: 1, total: 2 },
      contextPercent: 25,
    });
    expect(remoteSummaryCounts(undefined, [])).toEqual({
      agents: 0,
      jobs: 0,
      todos: null,
      contextPercent: null,
    });
  });

  test("shows where it runs, its context, to-dos, jobs, files and the plan's usage", () => {
    const html = renderToStaticMarkup(
      <RemoteSidePanel
        target={target}
        panel={panel({
          todos: [{ content: "Write the test", status: "in_progress" }],
          tasks: [
            { taskId: "j1", type: "local_bash", description: "dev server", status: "running" },
          ],
          changedFiles: [{ path: "/src/api/a.ts", added: 3, removed: 1 }],
          context: { usedTokens: 50_000, maxTokens: 200_000 },
          planLimits: [{ kind: "session", percent: 40 }],
        })}
        model={{ ...emptyModel(), model: "claude-opus-5-5" }}
        controls
        onShowAgent={() => {}}
        onCompact={() => {}}
        onStopTask={() => {}}
      />,
    );
    expect(html).toContain("Work PC");
    expect(html).toContain("/src/api");
    expect(html).toContain("claude-opus-5-5");
    expect(html).toContain("work");
    expect(html).toContain("25%");
    expect(html).toContain("Compact");
    expect(html).toContain("Write the test");
    expect(html).toContain("dev server");
    // Folded, as a chat here's: the files and the usage count on their titles.
    expect(html).toContain("Changed files");
    expect(html).toContain("Usage");
  });

  test("shows the first few jobs, those running and the newest, and counts the rest", () => {
    const job = (n: number, status: "running" | "completed") => ({
      taskId: `j${n}`,
      type: "local_bash",
      description: `job number ${n}`,
      status,
    });
    const html = renderToStaticMarkup(
      <RemoteSidePanel
        target={target}
        panel={panel({
          tasks: [
            job(1, "running"),
            job(2, "completed"),
            job(3, "completed"),
            job(4, "completed"),
            job(5, "completed"),
          ],
        })}
        model={emptyModel()}
        controls
        onShowAgent={() => {}}
        onCompact={() => {}}
        onStopTask={() => {}}
      />,
    );
    // Each once, though a row names its job twice (its text and its title).
    const shown = [...new Set([...html.matchAll(/job number (\d)/g)].map((match) => match[1]))];
    expect(shown).toEqual(["1", "5", "4"]);
    expect(html).toContain("Show 2 more");
  });

  test("lets only a computer that allows control be compacted or have its runs stopped", () => {
    const html = renderToStaticMarkup(
      <RemoteSidePanel
        target={target}
        panel={panel({
          tasks: [
            { taskId: "j1", type: "local_bash", description: "dev server", status: "running" },
          ],
          context: { usedTokens: 1, maxTokens: 2 },
        })}
        model={emptyModel()}
        controls={false}
        onShowAgent={() => {}}
        onCompact={() => {}}
        onStopTask={() => {}}
      />,
    );
    expect(html).not.toContain("Compact");
    expect(html).not.toContain("Stop");
  });

  test("names the plan's meters as the usage line does, the week's too", () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key} ${JSON.stringify(options)}` : key;
    expect(usageMeterLabel(t, { kind: "weekly", percent: 1 })).toBe("chat.usage.kind.weekly");
    expect(usageMeterLabel(t, { kind: "weekly", percent: 1 }, true)).toBe(
      "chat.usage.kind.weekly_all",
    );
    expect(usageMeterLabel(t, { kind: "session", percent: 1 })).toBe("chat.usage.kind.session");
    expect(usageMeterLabel(t, { kind: "window", windowMins: 300, percent: 1 })).toBe(
      'chat.usage.kind.hours {"count":5}',
    );
  });

  test("a bare /status, /context or /usage shows its part of the panel", () => {
    expect(remotePanelPartOf("/context")).toBe("context");
    expect(remotePanelPartOf(" /Usage ")).toBe("usage");
    expect(remotePanelPartOf("/status")).toBe("status");
    // With words after it, it goes to the computer as typed.
    expect(remotePanelPartOf("/context more")).toBeNull();
    expect(remotePanelPartOf("/compact")).toBeNull();
  });

  test("its profile shows at the end of the usage line, a plain label when it may only be looked at", () => {
    const chat = { ...target, kind: "claude" as const };
    const plain = renderToStaticMarkup(
      <RemoteProfileChip target={chat} busy={false} conversation controls={false} />,
    );
    expect(plain).toContain("work");
    expect(plain).not.toContain("<button");
    const live = renderToStaticMarkup(
      <RemoteProfileChip target={chat} busy={false} conversation controls />,
    );
    expect(live).toContain("<button");
    // A chat whose computer told no profile has no chip.
    expect(
      renderToStaticMarkup(
        <RemoteProfileChip
          target={{ ...chat, profile: undefined }}
          busy={false}
          conversation
          controls
        />,
      ),
    ).toBe("");
  });
});
