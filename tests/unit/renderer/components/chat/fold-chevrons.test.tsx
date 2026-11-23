import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRow } from "../../../../../src/renderer/components/chat/tool-row";
import { ToolRunLine } from "../../../../../src/renderer/components/chat/tool-run-line";
import type { ToolCall } from "../../../../../src/renderer/services/chat/model";
import { tallyCalls } from "../../../../../src/renderer/services/chat/tool-runs";

const { Thinking } = await import("../../../../../src/renderer/components/chat/message-list");

const call: ToolCall = {
  id: "c",
  name: "Bash",
  input: { command: "ls" },
  status: "done",
  parentToolUseId: null,
};

function folded(html: string) {
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("lucide-chevron-down");
  expect(html).not.toContain("lucide-chevron-right");
}

test("a call's line, folded, ends with a chevron down", () => {
  folded(
    renderToStaticMarkup(
      <ToolRow toolUseId="c" tool={call} tools={{ c: call }} toolStatuses={{}} cwd="/p" />,
    ),
  );
});

test("a run's line, folded, ends with a chevron down", () => {
  const tally = tallyCalls([{ name: "Bash" }, { name: "Bash" }]);
  folded(
    renderToStaticMarkup(
      <ToolRunLine tally={tally} running={false} open={false} onToggle={() => {}} />,
    ),
  );
  const open = renderToStaticMarkup(
    <ToolRunLine tally={tally} running={false} open onToggle={() => {}} />,
  );
  expect(open).toContain("lucide-chevron-up");
});

test("a thought, folded, ends with a chevron down", () => {
  folded(renderToStaticMarkup(<Thinking text="Weighing it" />));
});
