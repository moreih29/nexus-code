import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGitGroupContextMenuItems } from "../../../../../../src/renderer/components/files/git/file-row/file-context-menu";
import { GitGroupHeader } from "../../../../../../src/renderer/components/files/git/file-row/group-header";

const actions = {
  stageAll: () => {},
  unstageAll: () => {},
  discardAll: () => {},
  stashGroup: () => {},
};

function header(groupKey: "merge" | "working"): string {
  return renderToStaticMarkup(
    <GitGroupHeader
      groupKey={groupKey}
      label="Group"
      count={1}
      expanded
      onToggle={() => {}}
      onStageAll={actions.stageAll}
      onStashGroup={groupKey === "merge" ? undefined : actions.stashGroup}
    />,
  );
}

test("the merge group has no menu items", () => {
  expect(buildGitGroupContextMenuItems("merge", actions)).toEqual([]);
});

test("other groups still have menu items", () => {
  const items = buildGitGroupContextMenuItems("working", actions);
  expect(items.some((item) => item.kind === "item")).toBe(true);
});

test("the merge group header offers no group menu button", () => {
  expect(header("merge")).not.toContain('aria-haspopup="menu"');
  expect(header("working")).toContain('aria-haspopup="menu"');
});
