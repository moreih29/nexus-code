/**
 * An agent's own turn, as a `claude -p` run's pane and an agent's card show
 * it, folds calls in a row into one line as the main conversation does.
 */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFlow } from "../../../../../src/renderer/components/agent-list/agent-flow";
import type { AgentRun, ToolRun } from "../../../../../src/shared/claude/activity";

const tool = (id: string, name: string, target: string, at: number, extra: Partial<ToolRun> = {}) =>
  ({ id, name, target, start: at, end: at + 1, ...extra }) satisfies ToolRun;

function run(tools: ToolRun[], messages: AgentRun["messages"] = []): AgentRun {
  return {
    id: "run",
    kind: "print",
    start: 0,
    end: 100,
    state: "completed",
    answer: "done",
    tools,
    messages,
    toolCount: tools.length,
    failedCount: 0,
    toolsTold: true,
  };
}

const runs = (html: string) => html.split('data-testid="chat-tool-run"').length - 1;

test("calls in a row fold into one line that tells what they did", () => {
  const html = renderToStaticMarkup(
    <AgentFlow
      agent={run([
        tool("a", "Read", "/p/README.md", 1),
        tool("b", "Bash", "ls", 2),
        tool("c", "Bash", "pwd", 3),
      ])}
      now={100}
    />,
  );
  expect(runs(html)).toBe(1);
  expect(html).toContain("Ran 2 commands · Read 1 file");
  // Folded, the calls that ended do not show one by one.
  expect(html).not.toContain(">pwd<");
});

test("what the agent wrote between calls ends a run, and a lone call keeps its line", () => {
  const html = renderToStaticMarkup(
    <AgentFlow
      agent={run(
        [tool("a", "Bash", "ls", 1), tool("b", "Bash", "pwd", 2), tool("c", "Bash", "whoami", 4)],
        [{ at: 3, text: "Now who am I" }],
      )}
      now={100}
    />,
  );
  expect(runs(html)).toBe(1);
  expect(html).toContain(">whoami<");
});

test("a call still going shows under its folded run", () => {
  const html = renderToStaticMarkup(
    <AgentFlow
      agent={{
        ...run([tool("a", "Bash", "ls", 1), tool("b", "Bash", "sleep 9", 2, { end: undefined })]),
        end: undefined,
        state: "running",
        answer: undefined,
      }}
      now={5}
    />,
  );
  expect(runs(html)).toBe(1);
  expect(html).toContain(">sleep 9<");
  expect(html).not.toContain(">ls<");
});
