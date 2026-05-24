/**
 * ViewModeToggle — UI behaviour regression (plan 60 issues 2, 5).
 *
 *   - Renders two segments, the current `mode` aria-pressed.
 *   - `disabled` propagates to both <button>s and exposes `disabledReason`
 *     via the wrapping fieldset's `title` attribute.
 *   - `.mdx` toggle path lives in EditorView, but this file fixes the
 *     toggle's contract that EditorView relies on.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewModeToggle } from "../../../../../../src/renderer/components/editor/preview/view-mode-toggle";

describe("ViewModeToggle", () => {
  test("marks the active segment aria-pressed", () => {
    const html = renderToStaticMarkup(<ViewModeToggle mode="raw" onChange={() => {}} />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Raw");
    expect(html).toContain("Preview");
  });

  test("disabled prop disables both segments and exposes the reason via title", () => {
    const html = renderToStaticMarkup(
      <ViewModeToggle
        mode="raw"
        onChange={() => {}}
        disabled
        disabledReason="MDX preview is disabled for security"
      />,
    );
    // fieldset[disabled] + title attribute carry the disabled state.
    expect(html).toContain("disabled");
    expect(html).toContain("MDX preview is disabled for security");
  });
});
