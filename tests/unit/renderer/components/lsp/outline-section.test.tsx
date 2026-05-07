// Regression test for OutlineSection after the live-refresh refactor.
//
// bun:test runs without jsdom/happy-dom so useEffect does not execute in
// renderToStaticMarkup. The effect logic (setActiveOutlineUri calls) is
// covered by outline-live-refresh.test.ts. This suite guards against
// render regressions only.

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mock the outline-live-refresh module so the import side-effect (module-level
// subscriptions) does not interfere with the static render.
mock.module("../../../../../src/renderer/state/stores/outline-live-refresh", () => ({
  setActiveOutlineUri: mock(() => {}),
  __setOutlineRefreshSubscribersForTests: mock(() => {}),
  __resetOutlineRefreshSubscribersForTests: mock(() => {}),
}));

// Mock model-release dynamic import to avoid IPC side effects.
mock.module("../../../../../src/renderer/components/lsp/outline/model-release", () => ({
  ensureOutlineModelReleaseSubscription: mock(() => {}),
}));

// Mock outline store — static render reads no real store.
mock.module("../../../../../src/renderer/state/stores/outline", () => ({
  useOutlineStore: (selector: (state: unknown) => unknown) =>
    selector({
      entries: new Map(),
      cursorByUri: new Map(),
      load: mock(() => Promise.resolve()),
    }),
}));

const { OutlineSection } = await import(
  "../../../../../src/renderer/components/lsp/outline/outline-section"
);

describe("OutlineSection render regression", () => {
  test("renders with no active input (idle state)", () => {
    const html = renderToStaticMarkup(
      createElement(OutlineSection, {
        activeInput: null,
        collapsed: false,
        onToggleCollapsed: () => {},
      }),
    );
    expect(html).toContain("Outline");
    expect(html).toContain("No editor");
  });

  test("renders with an active file input", () => {
    const html = renderToStaticMarkup(
      createElement(OutlineSection, {
        activeInput: { workspaceId: "ws-1", filePath: "/workspace/src/app.ts" },
        collapsed: false,
        onToggleCollapsed: () => {},
      }),
    );
    expect(html).toContain("Outline");
    expect(html).toContain("app.ts");
  });

  test("renders collapsed state (hides outline content)", () => {
    const html = renderToStaticMarkup(
      createElement(OutlineSection, {
        activeInput: { workspaceId: "ws-1", filePath: "/workspace/src/app.ts" },
        collapsed: true,
        onToggleCollapsed: () => {},
      }),
    );
    expect(html).toContain("Outline");
    // The outline content area is not rendered when collapsed.
    expect(html).not.toContain("Loading outline");
    expect(html).not.toContain("Open an editor tab");
  });
});
