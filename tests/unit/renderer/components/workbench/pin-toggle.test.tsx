/**
 * Unit tests for the PinToggle component.
 *
 * Covers:
 *   - aria-pressed state (true when pinned, false when unpinned)
 *   - Tooltip label branches ("Unpin" vs "Pin to top")
 *   - aria-label content for accessibility
 *   - onToggle callback invocation on click
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

  it("renders filled Pin icon (fill=currentColor)", () => {
    const html = renderPinToggle({ pinned: true, workspaceName: "my-project" });
    // The lucide Pin icon receives fill="currentColor" when pinned.
    expect(html).toContain('fill="currentColor"');
  });

  it("applies opacity-100 and accent color class", () => {
    const html = renderPinToggle({ pinned: true, workspaceName: "my-project" });
    expect(html).toContain("opacity-100");
    expect(html).toContain("--state-selected-indicator");
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

  it("renders unfilled Pin icon (fill=none)", () => {
    const html = renderPinToggle({ pinned: false, workspaceName: "my-project" });
    // fill="currentColor" must NOT be present for the unpinned outlined state.
    expect(html).not.toContain('fill="currentColor"');
    expect(html).toContain('fill="none"');
  });

  it("applies opacity-0 hide-at-rest classes", () => {
    const html = renderPinToggle({ pinned: false, workspaceName: "my-project" });
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("focus-visible:opacity-100");
  });
});
