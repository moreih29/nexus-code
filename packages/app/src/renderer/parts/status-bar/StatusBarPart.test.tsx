import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import { StatusBarPart } from "./StatusBarPart";

describe("StatusBarPart", () => {
  test("renders file LSP status, diagnostics, and language", () => {
    const tree = StatusBarPart({
      activeItem: {
        kind: "file",
        lspStatus: {
          language: "typescript",
          state: "ready",
          serverName: "typescript-language-server",
          message: "ready",
          updatedAt: "2026-04-29T00:00:00.000Z",
        },
        diagnostics: [
          {
            path: "src/index.ts",
            language: "typescript",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: "error",
            message: "Cannot find name 'missing'.",
          },
        ],
        language: "typescript",
      },
    });

    expect(textContent(tree)).toContain("LSP: ready");
    expect(textContent(tree)).toContain("1 error");
    expect(textContent(tree)).toContain("TypeScript");
    expect(findElement(tree, (element) => element.props["data-slot"] === "status-bar")).toBeDefined();
    expect(findElement(tree, (element) => element.props["data-status-bar-file-lsp"] === "true")).toBeDefined();
  });

  test("renders terminal shell, cwd basename, and muted pid", () => {
    const tree = StatusBarPart({
      activeItem: {
        kind: "terminal",
        shell: "/bin/zsh",
        cwd: "/Users/kih/workspaces/areas/nexus-code",
        pid: 42_424,
      },
    });
    const pid = findElement(tree, (element) => element.props["data-status-bar-terminal-pid"] === "true");

    expect(textContent(tree)).toContain("zsh · nexus-code · 42424");
    expect(String(pid?.props.className)).toContain("text-muted-foreground");
  });
});

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }

    if (typeof node.type === "function") {
      return findElement(node.type(node.props), predicate);
    }

    return findElement(node.props.children, predicate);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactElement(node)) {
    if (typeof node.type === "function") {
      return textContent(node.type(node.props));
    }

    return textContent(node.props.children);
  }

  if (Array.isArray(node)) {
    return node.map((child) => textContent(child)).join(" ").replace(/\s+/g, " ").trim();
  }

  return "";
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
