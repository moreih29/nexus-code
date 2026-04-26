import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import { ClaudeSettingsConsentDialog } from "./ClaudeSettingsConsentDialog";

describe("ClaudeSettingsConsentDialog", () => {
  test("describes workspace-local settings, gitignore, backup, and don't ask again choice", () => {
    const tree = ClaudeSettingsConsentDialog({
      open: true,
      workspaceName: "Alpha",
      onOpenChange: () => {},
      onApprove: () => {},
      onCancel: () => {},
    });

    expect(flatText(tree)).toContain("Enable Claude Code hooks for");
    expect(flatText(tree)).toContain("Alpha");
    expect(flatText(tree)).toContain(".claude/settings.local.json");
    expect(flatText(tree)).toContain(".gitignore");
    expect(flatText(tree)).toContain("one-time backup");
    expect(flatText(tree)).toContain("Don't ask again for this workspace");
  });
});

function flatText(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(flatText).join(" ");
  }
  if (isReactElement(node)) {
    return flatText(node.props.children);
  }
  return "";
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
