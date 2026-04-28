import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { DiffEditorHost, diffEditorAriaLabel, diffEditorLayoutLabel } from "./DiffEditorHost";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("DiffEditorHost", () => {
  test("renders a read-only accessible diff region with layout and j/k navigation controls", () => {
    const html = renderToStaticMarkup(
      <DiffEditorHost
        left={{
          workspaceId,
          path: "src/old.ts",
          title: "old.ts",
          content: "old",
          language: "typescript",
          monacoLanguage: "typescript",
        }}
        right={{
          workspaceId,
          path: "src/new.ts",
          title: "new.ts",
          content: "new",
          language: "typescript",
          monacoLanguage: "typescript",
        }}
      />,
    );

    expect(html).toContain('data-component="diff-editor-host"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Diff: src/old.ts versus src/new.ts"');
    expect(html).toContain("Read-only diff");
    expect(html).toContain('data-action="diff-toggle-layout"');
    expect(html).toContain('data-action="diff-previous-change"');
    expect(html).toContain('data-action="diff-next-change"');
    expect(html).toContain('data-diff-editor-surface="true"');
  });

  test("formats stable labels for tests and tab ARIA", () => {
    expect(diffEditorAriaLabel("a.ts", "b.ts")).toBe("Diff: a.ts versus b.ts");
    expect(diffEditorLayoutLabel(true)).toBe("Inline");
    expect(diffEditorLayoutLabel(false)).toBe("Side-by-side");
  });
});
