import { describe, expect, test } from "bun:test";
import type { Virtualizer } from "@tanstack/react-virtual";
import { renderToStaticMarkup } from "react-dom/server";
import type { DisplayItem } from "../../../../../../src/renderer/components/files/file-tree/display";
import { FileTreeEditRow } from "../../../../../../src/renderer/components/files/file-tree/edit-row";
import { ROW_HEIGHT_PX } from "../../../../../../src/renderer/components/files/file-tree/metrics";
import { FileTreeVirtualBody } from "../../../../../../src/renderer/components/files/file-tree/virtual-body";

const noop = () => {};

describe("file tree edit row layout", () => {
  test("an invalid name's message floats under the input and keeps the row height", () => {
    const html = renderToStaticMarkup(
      <FileTreeEditRow kind="file" depth={0} initialValue="a//b" onCommit={noop} onCancel={noop} />,
    );

    expect(html).toStartWith(`<div class="flex items-center" style="height:${ROW_HEIGHT_PX}px`);
    expect(html).toMatch(
      /<span class="absolute top-full[^"]*">Path segments cannot be empty\.<\/span>/,
    );
  });

  test("edit rows paint above the rows after them", () => {
    const displayFlat: DisplayItem[] = [
      { kind: "pending", parentAbsPath: "/ws", entryKind: "file", depth: 1 },
      { kind: "rename", absPath: "/ws/b.ts", entryKind: "file", depth: 1, initialName: "b.ts" },
    ];
    const virtualizer = {
      getTotalSize: () => displayFlat.length * ROW_HEIGHT_PX,
      getVirtualItems: () =>
        displayFlat.map((_, index) => ({ index, start: index * ROW_HEIGHT_PX })),
    } as unknown as Virtualizer<HTMLDivElement, Element>;

    const html = renderToStaticMarkup(
      <FileTreeVirtualBody
        workspaceId="ws"
        tree={undefined}
        displayFlat={displayFlat}
        flat={[]}
        activeAbsPath={undefined}
        isPathSelected={() => false}
        isPathCut={() => false}
        encodeRowId={(p) => p}
        virtualizer={virtualizer}
        decorationLookup={{ decoration: () => undefined, isIgnored: () => false }}
        onRowClick={noop}
        onRowDoubleClick={noop}
        onRowContextMenu={noop}
        onPendingCommit={noop}
        onPendingCancel={noop}
        onPendingRenameCommit={noop}
        onPendingRenameCancel={noop}
      />,
    );

    expect(html).toMatch(/style="[^"]*z-index:1"[^>]*data-file-tree-row-type="pending"/);
    expect(html).toMatch(/style="[^"]*z-index:1"[^>]*data-file-tree-row-type="rename"/);
  });
});
