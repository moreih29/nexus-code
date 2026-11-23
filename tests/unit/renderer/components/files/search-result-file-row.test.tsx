/** A search result's file row folds its matches and tells a screen reader whether they show. */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchResultFileRow } from "../../../../../src/renderer/components/files/search/result-file-row";

test("a result's file row tells whether its matches show", () => {
  const row = (expanded: boolean) =>
    renderToStaticMarkup(
      <SearchResultFileRow
        relPath="src/a.ts"
        matchCount={2}
        expanded={expanded}
        onToggle={() => {}}
      />,
    );
  expect(row(false)).toContain('aria-expanded="false"');
  expect(row(true)).toContain('aria-expanded="true"');
});
