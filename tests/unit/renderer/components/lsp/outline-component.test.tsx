import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutlineContent } from "../../../../../src/renderer/components/lsp/outline/outline-content";
import {
  OUTLINE_REFRESH_DEBOUNCE_MS,
  scheduleDebouncedOutlineLoad,
} from "../../../../../src/renderer/components/lsp/outline/outline-section";
import {
  buildOutlineRows,
  collectExpandableIds,
  currentSymbolId,
  reduceOutlineKeyboard,
} from "../../../../../src/renderer/components/lsp/outline/outline-tree";
import type { DocumentSymbol } from "../../../../../src/shared/lsp-types";

function loadDocumentSymbolFixture(): DocumentSymbol[] {
  const fixturePath = join(
    process.cwd(),
    "tests/fixtures/lsp/pyright/responses/document-symbol-module_a.json",
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    response: { result: DocumentSymbol[] };
  };
  return fixture.response.result;
}

const symbols = loadDocumentSymbolFixture();

function renderOutline(state: Parameters<typeof OutlineContent>[0]["state"]): string {
  return renderToStaticMarkup(createElement(OutlineContent, { state }));
}

describe("OutlineContent states", () => {
  test("renders idle state", () => {
    expect(renderOutline({ phase: "idle", symbols: [] })).toContain(
      "Open an editor tab to view symbols.",
    );
  });

  test("renders loading state", () => {
    expect(renderOutline({ phase: "loading", symbols: [] })).toContain("Loading outline…");
  });

  test("renders empty state", () => {
    expect(renderOutline({ phase: "empty", symbols: [] })).toContain("No symbols found.");
  });

  test("renders error state with retry affordance", () => {
    const html = renderOutline({ phase: "error", symbols: [], errorMessage: "LSP offline" });

    expect(html).toContain("LSP offline");
    expect(html).toContain("Retry");
  });

  test("renders ready state as an ARIA tree", () => {
    const html = renderOutline({ phase: "ready", symbols });

    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Document outline"');
  });
});

describe("OutlineTree hierarchy and accessibility", () => {
  test("replays the document-symbol fixture as a hierarchical tree", () => {
    const html = renderOutline({ phase: "ready", symbols });

    expect(html).toContain("Greeter");
    expect(html).toContain("__init__");
    expect(html).toContain("greet");
    expect(html).toContain("format_greeting");
  });

  test("renders treeitem ARIA levels and expansion state", () => {
    const html = renderOutline({ phase: "ready", symbols });

    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('aria-level="3"');
    expect(html).toContain('aria-expanded="true"');
  });

  test("marks the deepest symbol containing the cursor as current", () => {
    const cursorPosition = { line: 7, character: 10 };
    const html = renderOutline({ phase: "ready", symbols, cursorPosition });

    expect(currentSymbolId(symbols, cursorPosition)).toBe("0.1");
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('data-current="true"');
  });

  test("uses the stronger focus border token for selected and focused rows", () => {
    const html = renderOutline({ phase: "ready", symbols });
    const themeCss = readFileSync(
      join(process.cwd(), "src/renderer/styles/theme.generated.css"),
      "utf8",
    );

    expect(themeCss).toContain("--color-mist-border-focus: rgba(226, 226, 226, 0.6);");
    expect(html).toContain("border-l-mist-border-focus");
    expect(html).toContain("focus-visible:ring-mist-border-focus");
  });
});

describe("outline keyboard reducer", () => {
  test("ArrowDown and ArrowUp move active row through visible rows", () => {
    const expandedIds = collectExpandableIds(symbols);
    const rows = buildOutlineRows(symbols, expandedIds);

    const down = reduceOutlineKeyboard("ArrowDown", rows, { activeId: "0", expandedIds });
    expect(down.activeId).toBe("0.0");

    const up = reduceOutlineKeyboard("ArrowUp", rows, down);
    expect(up.activeId).toBe("0");
  });

  test("ArrowRight expands a collapsed row, then moves to its first child", () => {
    const collapsed = new Set<string>();
    const collapsedRows = buildOutlineRows(symbols, collapsed);

    const expanded = reduceOutlineKeyboard("ArrowRight", collapsedRows, {
      activeId: "0",
      expandedIds: collapsed,
    });
    expect(expanded.expandedIds.has("0")).toBe(true);
    expect(expanded.activeId).toBe("0");

    const expandedRows = buildOutlineRows(symbols, expanded.expandedIds);
    const child = reduceOutlineKeyboard("ArrowRight", expandedRows, expanded);
    expect(child.activeId).toBe("0.0");
  });

  test("ArrowLeft collapses expanded rows or moves to the parent", () => {
    const expandedIds = collectExpandableIds(symbols);
    const rows = buildOutlineRows(symbols, expandedIds);

    const parent = reduceOutlineKeyboard("ArrowLeft", rows, {
      activeId: "0.1.0",
      expandedIds,
    });
    expect(parent.activeId).toBe("0.1");

    const collapsed = reduceOutlineKeyboard("ArrowLeft", rows, parent);
    expect(collapsed.activeId).toBe("0.1");
    expect(collapsed.expandedIds.has("0.1")).toBe(false);
  });
});

describe("outline refresh debounce", () => {
  test("debounces rapid outline load scheduling by cancelling stale timers", () => {
    const scheduled: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
    const loadCalls: Array<{ uri: string; signal?: AbortSignal }> = [];
    const load = mock((uri: string, signal?: AbortSignal) => {
      loadCalls.push({ uri, signal });
      return Promise.resolve();
    });
    const setTimeoutFn = (callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs, cleared: false });
      return scheduled.length - 1;
    };
    const clearTimeoutFn = (timerId: number) => {
      const timer = scheduled[timerId];
      if (timer) timer.cleared = true;
    };

    const cancelFirst = scheduleDebouncedOutlineLoad({
      uri: "file:///workspace/a.ts",
      load,
      setTimeoutFn,
      clearTimeoutFn,
    });
    cancelFirst();

    scheduleDebouncedOutlineLoad({
      uri: "file:///workspace/b.ts",
      load,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(scheduled.map((timer) => timer.delayMs)).toEqual([
      OUTLINE_REFRESH_DEBOUNCE_MS,
      OUTLINE_REFRESH_DEBOUNCE_MS,
    ]);

    for (const timer of scheduled) {
      if (!timer.cleared) timer.callback();
    }

    expect(load).toHaveBeenCalledTimes(1);
    expect(loadCalls[0]?.uri).toBe("file:///workspace/b.ts");
    expect(loadCalls[0]?.signal?.aborted).toBe(false);
  });
});
