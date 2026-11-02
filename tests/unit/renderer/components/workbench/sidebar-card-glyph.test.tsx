/**
 * The glyph a workspace card shows: Claude's aggregate state, or the state
 * Codex and other agents' output tells when that is stronger.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStatusGlyph } from "../../../../../src/renderer/components/sidebar/workspace-status-glyph";
import { cardGlyph } from "../../../../../src/renderer/components/workbench/sidebar";

describe("cardGlyph", () => {
  it("shows Claude's state when no other agent tells a stronger one", () => {
    expect(cardGlyph(null, null)).toBeNull();
    expect(cardGlyph("idle", null)).toEqual({ status: "idle", estimated: false });
    expect(cardGlyph("running", "running")).toEqual({ status: "running", estimated: false });
    expect(cardGlyph("needsInput", "completed")).toEqual({
      status: "needsInput",
      estimated: false,
    });
  });

  it("shows another agent's state, as estimated, when it is stronger", () => {
    expect(cardGlyph(null, "running")).toEqual({ status: "running", estimated: true });
    expect(cardGlyph("idle", "completed")).toEqual({ status: "completed", estimated: true });
    expect(cardGlyph("running", "completed")).toEqual({ status: "completed", estimated: true });
  });

  it("says an estimated state is one, in words and on hover", () => {
    const estimated = renderToStaticMarkup(<WorkspaceStatusGlyph status="running" estimated />);
    expect(estimated).toContain('aria-label="Running (estimated)"');
    expect(estimated).toContain('title="Running (estimated)"');
    const claude = renderToStaticMarkup(<WorkspaceStatusGlyph status="running" />);
    expect(claude).toContain('aria-label="Claude: running"');
    expect(claude).not.toContain("title=");
  });
});
