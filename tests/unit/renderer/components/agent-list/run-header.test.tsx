import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { worktreeName } from "../../../../../src/renderer/components/agent-list/task-view";
import { RunHeader, runKindParts } from "../../../../../src/renderer/components/chat/run-header";
import type { AgentRun } from "../../../../../src/shared/claude/activity";

const base: AgentRun = {
  id: "0123456789abcdef",
  kind: "print",
  start: 0,
  state: "running",
  tools: [],
  toolCount: 2,
  failedCount: 0,
};

test("a run's kind line names the program, model, short session id and tools", () => {
  const parts = runKindParts({
    ...base,
    model: "opus",
    sessionId: "fedcba9876543210",
    toolsTold: true,
  });
  expect(parts[0]).toBe("claude -p run");
  expect(parts).toContain("opus");
  expect(parts).toContain("fedcba98");
  expect(parts).toHaveLength(4);
});

test("a subagent's kind line names its type, model and short id", () => {
  const parts = runKindParts({ ...base, kind: "subagent", type: "Explore", model: "haiku" });
  expect(parts.slice(0, 3)).toEqual(["Explore", "haiku", "01234567"]);
});

test("the run header shows the title, state and given actions", () => {
  const html = renderToStaticMarkup(
    <RunHeader
      run={{ ...base, start: Date.now(), toolsTold: true }}
      title="Fix the parser"
      actions={<button type="button">act</button>}
    />,
  );
  expect(html).toContain("Fix the parser");
  expect(html).toContain('data-tooltip="claude -p run · 2 tools"');
  expect(html).toContain("Running");
  expect(html).toContain(">act</button>");
});

test("a task is named by its first branch, a root workspace by its name", () => {
  expect(worktreeName("repo", true, "main")).toBe("repo");
  expect(worktreeName("task", false, undefined, null, "feature/x")).toBe("feature/x");
  expect(worktreeName("task", false, undefined, "")).toBe("task");
});
