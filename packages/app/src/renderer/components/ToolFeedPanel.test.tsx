import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { HarnessToolFeedEntry } from "../stores/harnessToolFeedStore";
import { ToolFeedPanel } from "./ToolFeedPanel";

const entries: HarnessToolFeedEntry[] = [
  {
    type: "harness/tool-call",
    status: "started",
    toolName: "Read",
    sessionId: "sess_tool_feed_001",
    adapterName: "claude-code",
    workspaceId: "ws_alpha",
    timestamp: "2026-04-26T05:15:01.000Z",
    inputSummary: "file_path: hello.py",
    receivedSequence: 1,
  },
  {
    type: "harness/tool-call",
    status: "completed",
    toolName: "Update",
    sessionId: "sess_tool_feed_001",
    adapterName: "claude-code",
    workspaceId: "ws_alpha",
    timestamp: "2026-04-26T05:15:02.000Z",
    inputSummary: "file_path: hello.py",
    resultSummary: "success: true",
    receivedSequence: 2,
  },
];

describe("ToolFeedPanel", () => {
  test("renders an honest empty state before tool calls arrive", () => {
    const tree = ToolFeedPanel({ entries: [], activeWorkspaceName: "Alpha" });

    expect(findText(tree, "No tool calls yet")).toBe(true);
    expect(findText(tree, "Run Claude Code tool calls in Alpha; live events will appear here.")).toBe(true);
  });

  test("renders recent tool calls newest first with status labels and summaries", () => {
    const tree = ToolFeedPanel({ entries, activeWorkspaceName: "Alpha" });

    expect(findText(tree, "Live tool feed")).toBe(true);
    expect(findText(tree, "2 events")).toBe(true);
    expect(findText(tree, "Read")).toBe(true);
    expect(findText(tree, "Update")).toBe(true);
    expect(findText(tree, "Running")).toBe(true);
    expect(findText(tree, "Completed")).toBe(true);
    expect(findText(tree, "Input: file_path: hello.py")).toBe(true);
    expect(findText(tree, "Result: success: true")).toBe(true);

    const rows = findElementsByProp(tree, "data-tool-call-status");
    expect(rows.map((row) => row.props["data-tool-call-status"])).toEqual([
      "completed",
      "started",
    ]);
  });
});

function findElementsByProp(
  node: ReactNode,
  propName: string,
): ReactElement[] {
  const results: ReactElement[] = [];
  visitElements(node, (element) => {
    if (element.props?.[propName] !== undefined) {
      results.push(element);
    }
  });
  return results;
}

function visitElements(node: ReactNode, visit: (element: ReactElement) => void): void {
  if (isReactElement(node)) {
    visit(node);
    visitElements(node.props.children, visit);
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      visitElements(child, visit);
    }
  }
}

function findText(node: ReactNode, text: string): boolean {
  return textContent(node).includes(text);
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactElement(node)) {
    const propText = [node.props.title, node.props.description]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .join(" ");
    return `${propText} ${textContent(node.props.children)}`;
  }

  if (Array.isArray(node)) {
    return node.map((child) => textContent(child)).join("");
  }

  return "";
}
