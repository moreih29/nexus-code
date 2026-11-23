import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryRow } from "../../../../../src/renderer/components/files/git/history/row";
import { peerLogEntry } from "../../../../../src/renderer/components/peer-workspace/git-history";

const at = Date.now() - 5 * 60_000;
const commit = { hash: "0123456789abcdef", subject: "Add new file", author: "Ada", at };

function row(onOpenMenu?: () => void) {
  return renderToStaticMarkup(
    <HistoryRow
      entry={peerLogEntry(commit)}
      selected={false}
      tabIndex={0}
      ariaSetSize={1}
      ariaPosInSet={1}
      breakpoint="wide"
      onFocus={() => {}}
      onSelect={() => {}}
      onOpen={() => {}}
      onOpenMenu={onOpenMenu}
    />,
  );
}

test("a commit from another computer becomes a local history entry with no graph parents", () => {
  expect(peerLogEntry(commit)).toEqual({
    sha: commit.hash,
    parents: [],
    authorName: "Ada",
    authoredAt: new Date(at).toISOString(),
    subject: "Add new file",
  });
});

test("its row shows relative time like a local row, and no menu when read-only", () => {
  const readOnly = row();
  expect(readOnly).toContain("5 minutes ago");
  expect(readOnly).toContain("0123456");
  expect(readOnly).toContain("Ada");
  expect(readOnly).not.toContain("<button");
  expect(row(() => {})).toContain("<button");
});
