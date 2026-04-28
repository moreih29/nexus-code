import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SideBarPart } from "./SideBarPart";

describe("SideBarPart", () => {
  test("renders only the active Activity Bar route content", () => {
    const markup = renderToStaticMarkup(
      <SideBarPart
        route={{ title: "Search", contentId: "search" }}
        explorer={<div>Explorer content</div>}
        search={<div>Search content</div>}
        sourceControl={<div>Source Control content</div>}
        tool={<div>Tool content</div>}
        session={<div>Session content</div>}
        preview={<div>Preview content</div>}
      />,
    );

    expect(markup).toContain('data-component="side-bar"');
    expect(markup).toContain('data-active-content-id="search"');
    expect(markup).toContain("Search content");
    expect(markup).not.toContain("Explorer content");
    expect(markup).not.toContain("Source Control content");
    expect(markup).not.toContain("Tool content");
    expect(markup).not.toContain("Session content");
    expect(markup).not.toContain("Preview content");
  });
});
