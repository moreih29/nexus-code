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

  it("shows a Codex tab's state when it is stronger than Claude's", () => {
    expect(cardGlyph(null, null, "running")).toEqual({
      status: "running",
      estimated: false,
      codex: true,
    });
    expect(cardGlyph("idle", null, "permissionPending")).toEqual({
      status: "permissionPending",
      estimated: false,
      codex: true,
    });
    expect(cardGlyph("needsInput", null, "running")).toEqual({
      status: "needsInput",
      estimated: false,
    });
    expect(cardGlyph("completed", null, "completed")).toEqual({
      status: "completed",
      estimated: false,
    });
    // A terminal's estimate shows only over a weaker told state.
    expect(cardGlyph(null, "completed", "running")).toEqual({
      status: "completed",
      estimated: true,
    });
    expect(cardGlyph(null, "running", "running")).toEqual({
      status: "running",
      estimated: false,
      codex: true,
    });
  });

  it("names a Codex tab's state as Codex's", () => {
    const codex = renderToStaticMarkup(<WorkspaceStatusGlyph status="completed" codex />);
    expect(codex).toContain('aria-label="Codex: new result"');
    expect(codex).not.toContain("title=");
  });

  it("says an estimated state is one, in words and on hover", () => {
    const estimated = renderToStaticMarkup(<WorkspaceStatusGlyph status="running" estimated />);
    expect(estimated).toContain('aria-label="Working (estimated)"');
    expect(estimated).toContain('title="Working (estimated)"');
    const claude = renderToStaticMarkup(<WorkspaceStatusGlyph status="running" />);
    expect(claude).toContain('aria-label="Claude: working"');
    expect(claude).not.toContain("title=");
  });
});
