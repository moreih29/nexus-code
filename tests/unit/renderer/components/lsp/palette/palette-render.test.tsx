import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPaletteFrame } from "../../../../../../src/renderer/components/lsp/palette/command-palette";
import type { PaletteViewStatus } from "../../../../../../src/renderer/components/lsp/palette/controller";
import type { PaletteItem } from "../../../../../../src/renderer/components/lsp/palette/types";

const resultItems: PaletteItem[] = [
  {
    id: "greet",
    label: "Greet",
    detail: "src/greet.ts:3:1",
    kindLabel: "Function",
    ariaLabel: "Greet, Function, src/greet.ts:3:1",
    tooltip: "/workspace/src/greet.ts",
  },
];

function render(status: PaletteViewStatus, dimmed = false): string {
  return renderToStaticMarkup(
    <CommandPaletteFrame
      status={status}
      title="Go to Symbol in Workspace"
      placeholder="Search workspace symbols"
      query={status === "idle" || status === "closed" || status === "no-workspace" ? "" : "Gre"}
      items={status === "results" ? resultItems : []}
      activeIndex={status === "results" ? 0 : -1}
      dimmed={dimmed}
      emptyQueryMessage="Type a symbol name to search the workspace."
      noResultsMessage="No workspace symbols found."
      onQueryChange={() => {}}
    />,
  );
}

describe("CommandPaletteFrame render states", () => {
  it("renders all 8 palette states", () => {
    const states: PaletteViewStatus[] = [
      "closed",
      "no-workspace",
      "idle",
      "debouncing",
      "loading",
      "results",
      "empty",
      "error",
    ];

    const htmlByState = new Map(states.map((state) => [state, render(state)]));

    expect(htmlByState.get("closed")).toBe("");
    expect(htmlByState.get("no-workspace")).toContain("Open a workspace to search symbols.");
    expect(htmlByState.get("idle")).toContain("Type a symbol name to search the workspace.");
    expect(htmlByState.get("debouncing")).toContain("Waiting for input");
    expect(htmlByState.get("loading")).toContain("Searching");
    expect(htmlByState.get("results")).toContain("Greet");
    expect(htmlByState.get("empty")).toContain("No workspace symbols found.");
    expect(htmlByState.get("error")).toContain("Workspace symbol search failed.");
  });

  it("renders ARIA dialog, combobox, listbox, and option", () => {
    const html = render("results");

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-command-palette-root="true"');
  });

  it("uses the design backdrop, subtle selected row, and row tooltip", () => {
    const html = render("results");

    expect(html).toContain("bg-frosted-veil-strong");
    expect(html).toContain("bg-frosted-veil");
    expect(html).toContain('title="/workspace/src/greet.ts"');
  });

  it("list container has opacity-100 and no aria-busy when not dimmed", () => {
    const html = render("results", false);

    expect(html).toContain("opacity-100");
    expect(html).not.toContain("opacity-50");
    expect(html).not.toContain("pointer-events-none");
    expect(html).not.toContain("aria-busy");
  });

  it("list container has opacity-50, pointer-events-none, aria-busy=true when dimmed", () => {
    const html = render("results", true);

    expect(html).toContain("opacity-50");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("opacity-100");
  });

  it("list container always has transition-opacity duration-150", () => {
    const notDimmed = render("results", false);
    const dimmedHtml = render("results", true);

    expect(notDimmed).toContain("transition-opacity");
    expect(notDimmed).toContain("duration-150");
    expect(dimmedHtml).toContain("transition-opacity");
    expect(dimmedHtml).toContain("duration-150");
  });
});
