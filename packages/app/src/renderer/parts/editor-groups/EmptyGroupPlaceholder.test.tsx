import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import { EmptyGroupPlaceholder, shouldShowEmptyGroupPlaceholder } from "./empty-group-placeholder";

describe("EmptyGroupPlaceholder", () => {
  test("renders a centered muted status hint for the final empty editor group", () => {
    const tree = EmptyGroupPlaceholder();

    expect(tree.props.role).toBe("status");
    expect(tree.props["aria-label"]).toBe("Empty editor group");
    expect(tree.props["data-editor-empty-group-placeholder"]).toBe("true");
    expect(tree.props.className).toContain("items-center");
    expect(tree.props.className).toContain("justify-center");
    expect(tree.props.className).toContain("text-muted-foreground");
    expect(findText(tree, "No editor open")).toBe(true);
    expect(findText(tree, "Open a file from Explorer to start editing.")).toBe(true);
  });

  test("only displays for the final empty group", () => {
    expect(shouldShowEmptyGroupPlaceholder([{ tabs: [] }])).toBe(true);
    expect(shouldShowEmptyGroupPlaceholder([])).toBe(false);
    expect(shouldShowEmptyGroupPlaceholder([{ tabs: [{ id: "tab_a" }] }])).toBe(false);
    expect(shouldShowEmptyGroupPlaceholder([{ tabs: [] }, { tabs: [] }])).toBe(false);
  });
});

function findText(node: ReactNode, text: string): boolean {
  if (typeof node === "string") {
    return node === text;
  }

  if (Array.isArray(node)) {
    return node.some((child) => findText(child, text));
  }

  if (isReactElement(node)) {
    return findText(node.props.children as ReactNode, text);
  }

  return false;
}

function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "props" in node;
}
