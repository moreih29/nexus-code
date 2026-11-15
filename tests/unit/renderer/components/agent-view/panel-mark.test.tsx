/**
 * The mark of a session the agent view's panels have, the same on this computer's rows
 * and another computer's: shown in front of a panel, or held behind another tab.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SplitNode } from "../../../../../src/renderer/engine";

const { PanelMark, panelPlaceOf } = await import(
  "../../../../../src/renderer/components/agent-view/panel-mark"
);

const root: SplitNode = {
  kind: "split",
  id: "s1",
  orientation: "horizontal",
  ratio: 0.5,
  first: { kind: "leaf", id: "l1", tabIds: ["ws:a", "ws:b"], activeTabId: "ws:a" },
  second: { kind: "leaf", id: "l2", tabIds: ["remote:d2:w1:t1"], activeTabId: "remote:d2:w1:t1" },
};

describe("panelPlaceOf", () => {
  test("a session in front of a panel is shown, one behind another tab held", () => {
    expect(panelPlaceOf(root, "ws:a")).toBe("shown");
    expect(panelPlaceOf(root, "ws:b")).toBe("held");
    expect(panelPlaceOf(root, "remote:d2:w1:t1")).toBe("shown");
  });

  test("a session no panel has has no place", () => {
    expect(panelPlaceOf(root, "ws:c")).toBeNull();
  });
});

describe("PanelMark", () => {
  test("a bright bar where shown, a dim one where held, each saying which", () => {
    const shown = renderToStaticMarkup(<PanelMark where="shown" testId="m" />);
    expect(shown).toContain('aria-label="Shown in a panel"');
    expect(shown).toContain("bg-[var(--state-selected-indicator)]");
    const held = renderToStaticMarkup(<PanelMark where="held" testId="m" />);
    expect(held).toContain('aria-label="In a panel, behind another tab"');
    expect(held).toContain("bg-muted-foreground/60");
  });

  test("its row sets where it sits", () => {
    const html = renderToStaticMarkup(
      <PanelMark where="held" className="top-1 bottom-1" testId="m" />,
    );
    expect(html).toContain("top-1 bottom-1");
    expect(html).not.toContain("top-1.5");
  });
});
