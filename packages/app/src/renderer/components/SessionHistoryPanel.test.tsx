import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { ClaudeTranscriptReadResult } from "../../../../shared/src/contracts/e3-surfaces";
import type { HarnessSessionRef } from "../stores/harnessSessionStore";
import { SessionHistoryPanelView } from "./SessionHistoryPanel";

const sessionRef: HarnessSessionRef = {
  workspaceId: "ws_alpha",
  adapterName: "claude-code",
  sessionId: "sess_session_history_001",
  timestamp: "2026-04-26T05:15:00.000Z",
  transcriptPath: "/Users/kih/.claude/projects/project/session.jsonl",
  receivedSequence: 1,
};

const loadedResult: ClaudeTranscriptReadResult = {
  available: true,
  transcriptPath: sessionRef.transcriptPath,
  readAt: "2026-04-26T05:16:00.000Z",
  entries: [
    {
      lineNumber: 12,
      role: "user",
      kind: "user",
      summary: "중국어 추가.",
      timestamp: "2026-04-26T05:15:01.000Z",
    },
    {
      lineNumber: 13,
      role: "assistant",
      kind: "assistant",
      summary: "Update tool로 hello.py를 수정했습니다.",
    },
  ],
};

describe("SessionHistoryPanelView", () => {
  test("renders an empty state before Claude session history arrives", () => {
    const tree = SessionHistoryPanelView({
      sessionRef: null,
      result: null,
      loading: false,
      activeWorkspaceName: "Alpha",
    });

    expect(findText(tree, "No Claude session yet")).toBe(true);
    expect(findText(tree, "Run Claude Code in Alpha; transcript history will appear here.")).toBe(true);
  });

  test("renders loaded read-only transcript entries", () => {
    const tree = SessionHistoryPanelView({
      sessionRef,
      result: loadedResult,
      loading: false,
    });

    expect(findText(tree, "Session history")).toBe(true);
    expect(findText(tree, "2 lines")).toBe(true);
    expect(findText(tree, "중국어 추가.")).toBe(true);
    expect(findText(tree, "Update tool로 hello.py를 수정했습니다.")).toBe(true);

    const roles = findElementsByProp(tree, "data-session-entry-role").map(
      (element) => element.props["data-session-entry-role"],
    );
    expect(roles).toEqual(["user", "assistant"]);
  });

  test("renders unavailable transcript state", () => {
    const tree = SessionHistoryPanelView({
      sessionRef,
      result: {
        available: false,
        transcriptPath: sessionRef.transcriptPath,
        reason: "Claude transcript path is outside ~/.claude/projects.",
        readAt: "2026-04-26T05:16:00.000Z",
      },
      loading: false,
    });

    expect(findText(tree, "Session unavailable")).toBe(true);
    expect(findText(tree, "Claude transcript path is outside ~/.claude/projects.")).toBe(true);
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
