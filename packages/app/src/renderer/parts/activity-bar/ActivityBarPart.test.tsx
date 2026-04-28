import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_ACTIVITY_BAR_VIEWS } from "../../services/activity-bar-service";
import { ActivityBarPart } from "./ActivityBarPart";

describe("ActivityBarPart", () => {
  test("exposes the six default workbench views", () => {
    const markup = renderToStaticMarkup(
      <ActivityBarPart
        views={DEFAULT_ACTIVITY_BAR_VIEWS}
        activeViewId="source-control"
        onActiveViewChange={() => {}}
      />,
    );

    expect(markup).toContain('data-component="activity-bar"');
    expect(markup.match(/data-activity-view=/g)).toHaveLength(6);
    expect(markup).toContain('data-activity-view="explorer"');
    expect(markup).toContain('data-activity-view="search"');
    expect(markup).toContain('data-activity-view="source-control"');
    expect(markup).toContain('data-activity-view="tool"');
    expect(markup).toContain('data-activity-view="session"');
    expect(markup).toContain('data-activity-view="preview"');
    expect(markup).toContain('aria-label="Source Control"');
    expect(markup).toContain('aria-selected="true"');
  });
});
