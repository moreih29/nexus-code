/**
 * Unit tests for the PinToggle component.
 *
 * Covers:
 *   - aria-pressed state (true when pinned, false when unpinned)
 *   - aria-label branches ("Unpin workspace …" vs "Pin workspace … to top")
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Tooltip as RadixTooltip } from "radix-ui";
import { PinToggle } from "../../../../../src/renderer/components/workbench/pin-toggle";

// Radix Tooltip.Portal renders via a portal which doesn't appear in static
// markup; tooltip content assertions use the Trigger/button aria attributes instead.

/**
 * Wraps PinToggle in the required TooltipProvider so renderToStaticMarkup
 * doesn't throw. The Provider is always present in the sidebar in production.
 */
function renderPinToggle(props: { pinned: boolean; workspaceName: string }): string {
  return renderToStaticMarkup(
    <RadixTooltip.Provider>
      <PinToggle pinned={props.pinned} workspaceName={props.workspaceName} onToggle={() => {}} />
    </RadixTooltip.Provider>,
  );
}

describe("PinToggle — pinned=true", () => {
  it("renders aria-pressed=true", () => {
    const html = renderPinToggle({ pinned: true, workspaceName: "my-project" });
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders aria-label indicating unpin action", () => {
    const html = renderPinToggle({ pinned: true, workspaceName: "my-project" });
    expect(html).toContain('aria-label="Unpin workspace my-project"');
  });
});

describe("PinToggle — pinned=false", () => {
  it("renders aria-pressed=false", () => {
    const html = renderPinToggle({ pinned: false, workspaceName: "my-project" });
    expect(html).toContain('aria-pressed="false"');
  });

  it("renders aria-label indicating pin-to-top action", () => {
    const html = renderPinToggle({ pinned: false, workspaceName: "my-project" });
    expect(html).toContain('aria-label="Pin workspace my-project to top"');
  });
});
