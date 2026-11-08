/**
 * The state glyph spins for a state in progress, unless told to hold still:
 * a filter chip that counts no running agents names the state, nothing runs.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StateGlyph } from "../../../../../src/renderer/components/sessions/session-status";

describe("StateGlyph", () => {
  it("spins for a running state", () => {
    expect(renderToStaticMarkup(<StateGlyph state="running" />)).toContain("animate-spin");
  });

  it("holds still when asked, as for a count of none", () => {
    expect(renderToStaticMarkup(<StateGlyph state="running" still />)).not.toContain(
      "animate-spin",
    );
  });

  it("never spins for a state at rest", () => {
    expect(renderToStaticMarkup(<StateGlyph state="waiting" />)).not.toContain("animate-spin");
  });
});
