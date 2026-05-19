/**
 * ViewModeToggle unit tests.
 *
 * (a) aria-pressed semantics, accessible labels, click→viewMode toggle helper.
 *
 * Environment: bun:test, renderToStaticMarkup (no DOM / no jsdom).
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// Window IPC stub — some transitive imports check for window.ipc.
(globalThis as Record<string, unknown>).window = {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
};

import {
  ViewModeToggle,
  computeNextViewMode,
} from "../../../../../src/renderer/components/files/view-mode-toggle";

// ---------------------------------------------------------------------------
// (a-1) aria-pressed reflects viewMode correctly
// ---------------------------------------------------------------------------

describe("ViewModeToggle — aria-pressed", () => {
  it("aria-pressed=false when viewMode=list", () => {
    const html = renderToStaticMarkup(
      <ViewModeToggle viewMode="list" onViewModeChange={() => {}} />,
    );
    expect(html).toContain('aria-pressed="false"');
  });

  it("aria-pressed=true when viewMode=tree", () => {
    const html = renderToStaticMarkup(
      <ViewModeToggle viewMode="tree" onViewModeChange={() => {}} />,
    );
    expect(html).toContain('aria-pressed="true"');
  });
});

// ---------------------------------------------------------------------------
// (a-2) button label matches current viewMode
// ---------------------------------------------------------------------------

describe("ViewModeToggle — accessible label", () => {
  it("aria-label View as Tree in list mode", () => {
    const html = renderToStaticMarkup(
      <ViewModeToggle viewMode="list" onViewModeChange={() => {}} />,
    );
    expect(html).toContain("View as Tree");
  });

  it("aria-label View as List in tree mode", () => {
    const html = renderToStaticMarkup(
      <ViewModeToggle viewMode="tree" onViewModeChange={() => {}} />,
    );
    expect(html).toContain("View as List");
  });
});

// ---------------------------------------------------------------------------
// (a-3) click handler toggles viewMode
// ---------------------------------------------------------------------------

describe("ViewModeToggle — click toggles viewMode", () => {
  it("computeNextViewMode returns 'tree' when current is 'list'", () => {
    expect(computeNextViewMode("list")).toBe("tree");
  });

  it("computeNextViewMode returns 'list' when current is 'tree'", () => {
    expect(computeNextViewMode("tree")).toBe("list");
  });
});
