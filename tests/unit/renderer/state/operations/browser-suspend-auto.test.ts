/**
 * Regression tests for `isOccludingOverlay` — the predicate that decides
 * whether a DOM node matching the overlay-role selector actually occludes the
 * browser WebContentsView (and therefore warrants suspending it).
 *
 * THE BUG THIS GUARDS
 * -------------------
 * Monaco's Find/Replace widget is `.editor-widget.find-widget[role="dialog"]`.
 * Monaco creates it lazily (first Cmd+F) and then leaves it in the DOM forever
 * in a hidden state. The auto-suspend selector matches `[role="dialog"]`, so
 * before the fix the first Find in any editor left a permanent "overlay" node
 * behind → the browser stayed suspended (blank) until a manual resumeAll or a
 * restart, per workspace. `isOccludingOverlay` must reject Monaco widgets and
 * hidden nodes while still accepting genuine Radix portal overlays.
 *
 * No real DOM here — this project runs bun:test without jsdom/happy-dom, so we
 * hand-build element stubs that implement only the three methods the predicate
 * touches (`matches`, `closest`, `getAttribute`), matching the convention in
 * keybindings/context-keys.test.ts.
 */

import { describe, expect, test } from "bun:test";

import { isOccludingOverlay } from "../../../../../src/renderer/state/operations/browser-suspend-auto";

interface FakeSpec {
  /** el.matches(MONACO_WIDGET_SELECTOR) — the node itself is a Monaco widget. */
  isMonacoWidget?: boolean;
  /** el.closest(MONACO_WIDGET_SELECTOR) — the node sits inside the editor pane. */
  insideMonaco?: boolean;
  /** el.getAttribute("aria-hidden") === "true". */
  ariaHidden?: boolean;
  /** el.closest("[inert]") — the node sits in an inactive workspace panel. */
  insideInert?: boolean;
}

// matches() only ever sees the Monaco-widget selector; closest() sees that
// one or the inert-subtree selector, so the stub resolves both from the spec.
function fakeEl(spec: FakeSpec): Element {
  return {
    matches: () => Boolean(spec.isMonacoWidget),
    closest: (selector: string) => {
      if (selector === "[inert]") return spec.insideInert ? ({} as Element) : null;
      return spec.insideMonaco || spec.isMonacoWidget ? ({} as Element) : null;
    },
    getAttribute: (name: string) =>
      name === "aria-hidden" && spec.ariaHidden ? "true" : null,
  } as unknown as Element;
}

describe("isOccludingOverlay", () => {
  test("rejects Monaco's closed Find/Replace widget (the regression)", () => {
    // .editor-widget.find-widget[role=dialog][aria-hidden] inside .monaco-editor
    expect(isOccludingOverlay(fakeEl({ insideMonaco: true, ariaHidden: true }))).toBe(false);
  });

  test("rejects an open Monaco widget (find visible, role=dialog, not hidden)", () => {
    expect(isOccludingOverlay(fakeEl({ insideMonaco: true, ariaHidden: false }))).toBe(false);
  });

  test("rejects a Monaco overflow widget mounted outside .monaco-editor (matched by class)", () => {
    // fixedOverflowWidgets mounts at the body — caught by the `.editor-widget` self-match.
    expect(isOccludingOverlay(fakeEl({ isMonacoWidget: true, insideMonaco: false }))).toBe(false);
  });

  test("rejects any aria-hidden overlay node", () => {
    expect(isOccludingOverlay(fakeEl({ ariaHidden: true }))).toBe(false);
  });

  test("rejects an overlay left open in an inactive (inert) workspace panel", () => {
    expect(isOccludingOverlay(fakeEl({ insideInert: true }))).toBe(false);
  });

  test("accepts a genuine, visible Radix overlay (dialog / menu / popper)", () => {
    expect(isOccludingOverlay(fakeEl({}))).toBe(true);
  });
});
