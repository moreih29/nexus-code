/**
 * RowDropIndicator — class branching on position prop.
 *
 * Verifies that:
 *   - position="before" renders the top-edge bar (top-0, no bottom-0)
 *   - position="after"  renders the bottom-edge bar (bottom-0, no top-0)
 *   - both variants carry pointer-events-none and accent color token
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RowDropIndicator } from "../../../../../../src/renderer/components/workbench/dnd/row-drop-indicator";

describe("RowDropIndicator — position=before", () => {
  it("renders top-0 edge class", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="before" />);
    expect(html).toContain("top-0");
  });

  it("does not render bottom-0 edge class", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="before" />);
    expect(html).not.toContain("bottom-0");
  });

  it("is pointer-events-none", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="before" />);
    expect(html).toContain("pointer-events-none");
  });

  it("uses the selected-indicator color token", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="before" />);
    expect(html).toContain("--state-selected-indicator");
  });
});

describe("RowDropIndicator — position=after", () => {
  it("renders bottom-0 edge class", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="after" />);
    expect(html).toContain("bottom-0");
  });

  it("does not render top-0 edge class", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="after" />);
    expect(html).not.toContain("top-0");
  });

  it("is pointer-events-none", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="after" />);
    expect(html).toContain("pointer-events-none");
  });

  it("uses the selected-indicator color token", () => {
    const html = renderToStaticMarkup(<RowDropIndicator position="after" />);
    expect(html).toContain("--state-selected-indicator");
  });
});
