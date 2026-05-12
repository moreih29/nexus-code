/**
 * Scenario regression tests for HistoryRow breakpoint-specific columns.
 */
import { describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import type { LogEntry } from "../../../../../../src/shared/types/git";
import type { HistoryListBreakpoint } from "../../../../../../src/renderer/components/files/git/history/HistoryList";

const { HistoryRow } = await import(
  "../../../../../../src/renderer/components/files/git/history/HistoryRow"
);

type TestNode = TestDomElement | TestTextNode;

/** Text node used by the fake renderer so visible row labels are assertable. */
class TestTextNode {
  parent: TestDomElement | null = null;

  constructor(readonly value: string) {}

  get textContent(): string {
    return this.value;
  }
}

/** Minimal DOM element record for HistoryRow render assertions. */
class TestDomElement {
  readonly children: TestNode[] = [];
  parent: TestDomElement | null = null;

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown>,
  ) {}

  append(child: TestNode): void {
    child.parent = this;
    this.children.push(child);
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }
}

describe("HistoryRow breakpoint columns", () => {
  it("narrow rows show graph, subject, time, and actions while title keeps hidden metadata", () => {
    const row = renderHistoryRow("narrow");

    expect(String(row.props.className)).toContain(
      "grid-cols-[var(--graph-w)_minmax(0,1fr)_5ch_24px]",
    );
    expect(row.children).toHaveLength(4);
    expect(row.textContent).toContain("Subject stays visible");
    expect(row.textContent).not.toContain("refs");
    expect(row.textContent).not.toContain("Ada Lovelace");
    expect(row.textContent).not.toContain("abc1234");
    expect(String(row.props.title)).toContain("Author: Ada Lovelace");
    expect(String(row.props.title)).toContain("SHA: abc1234567890");
  });

  it("medium rows add refs and short SHA but keep author hidden", () => {
    const row = renderHistoryRow("medium");

    expect(String(row.props.className)).toContain(
      "grid-cols-[var(--graph-w)_minmax(0,auto)_minmax(0,1fr)_5ch_7ch_24px]",
    );
    expect(row.children).toHaveLength(6);
    expect(row.textContent).toContain("refs");
    expect(row.textContent).toContain("abc1234");
    expect(row.textContent).not.toContain("Ada Lovelace");
  });

  it("wide rows match the full seven-column layout with author", () => {
    const row = renderHistoryRow("wide");

    expect(String(row.props.className)).toContain(
      "grid-cols-[var(--graph-w)_minmax(0,auto)_minmax(0,1fr)_12ch_5ch_7ch_24px]",
    );
    expect(row.children).toHaveLength(7);
    expect(row.textContent).toContain("refs");
    expect(row.textContent).toContain("Ada Lovelace");
    expect(row.textContent).toContain("abc1234");
  });
});

/** Renders a row at one breakpoint with representative optional slots. */
function renderHistoryRow(breakpoint: HistoryListBreakpoint): TestDomElement {
  const roots = renderReactNode(
    React.createElement(HistoryRow, {
      entry: makeEntry(),
      selected: false,
      tabIndex: 0,
      ariaSetSize: 1,
      ariaPosInSet: 1,
      breakpoint,
      graphSlot: React.createElement("span", null, "graph"),
      refSlot: React.createElement("span", null, "refs"),
      onFocus: () => {},
      onSelect: () => {},
      onOpen: () => {},
      onOpenMenu: mock(() => {}),
    }),
  );
  const row = roots.find((node): node is TestDomElement => node instanceof TestDomElement);
  if (!row) throw new Error("HistoryRow rendered no element");
  return row;
}

/** Builds a deterministic commit row fixture. */
function makeEntry(): LogEntry {
  return {
    sha: "abc1234567890",
    shortSha: "abc1234",
    parents: [],
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.invalid",
    authoredAt: "2026-05-10T00:00:00.000Z",
    subject: "Subject stays visible",
    body: "",
  };
}

/** Executes a React node tree into minimal DOM-like nodes. */
function renderReactNode(node: ReactNode): TestNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [new TestTextNode(String(node))];
  if (Array.isArray(node)) return node.flatMap((child) => renderReactNode(child));
  if (!isReactElement(node)) return [];

  const { type, props } = node;
  if (type === React.Fragment) return renderReactNode(props.children as ReactNode);
  if (typeof type === "function") return renderReactNode(type(props as never) as ReactNode);
  if (typeof type !== "string") return [];

  const element = new TestDomElement(type, props as Record<string, unknown>);
  for (const child of renderReactNode(props.children as ReactNode)) element.append(child);
  return [element];
}

/** Narrows arbitrary React nodes to element records. */
function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}
