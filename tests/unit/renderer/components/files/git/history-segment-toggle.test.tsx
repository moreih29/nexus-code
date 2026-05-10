/**
 * Scenario tests for the Source Control Changes/History segment.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HistorySegmentToggle } from "../../../../../../src/renderer/components/files/git/history/HistorySegmentToggle";

describe("HistorySegmentToggle", () => {
  it("renders Changes and History tabs with persisted selection reflected", () => {
    const html = renderToStaticMarkup(
      <HistorySegmentToggle segment="history" onChange={() => {}} />,
    );

    expect(html).toContain("Changes");
    expect(html).toContain("History");
    expect(html).toContain('aria-selected="true"');
  });
});
