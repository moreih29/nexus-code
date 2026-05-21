/**
 * RowDropIndicator — minimal visual contract.
 *
 * The component has no props in the slot-based model; verifies that the
 * accent color token and pointer-events-none class are present so the
 * indicator never blocks drag events on the slot beneath it.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RowDropIndicator } from "../../../../../../src/renderer/components/workbench/dnd/row-drop-indicator";

describe("RowDropIndicator", () => {
  it("is pointer-events-none so it never blocks the slot's drop events", () => {
    const html = renderToStaticMarkup(<RowDropIndicator />);
    expect(html).toContain("pointer-events-none");
  });

  it("uses the selected-indicator color token", () => {
    const html = renderToStaticMarkup(<RowDropIndicator />);
    expect(html).toContain("--state-selected-indicator");
  });
});
