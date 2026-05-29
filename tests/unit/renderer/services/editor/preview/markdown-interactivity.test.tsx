/**
 * MarkdownPreview — interactive affordances.
 *
 * Covers the preview→source and view-only features added alongside the
 * Tailwind list-marker fix:
 *   1. Task checkboxes are interactive (enabled, tagged) when `onToggleTask`
 *      is supplied, and disabled otherwise.
 *   2. Headings get rehype-slug ids plus the anchor-copy and fold buttons.
 *   3. Code blocks are wrapped with a copy button.
 *
 * Mirrors markdown-security.test.tsx: stub the IPC-pulling modules so the
 * component renders under `bun test` without an Electron host.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../../../../../src/renderer/services/editor", () => ({
  openOrRevealEditor: mock(() => {}),
}));

mock.module("../../../../../../src/shared/log/renderer", () => ({
  createLogger: () => ({
    warn: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

const { MarkdownPreview } = await import(
  "../../../../../../src/renderer/components/editor/preview/markdown-preview"
);

const BASE_PROPS = {
  workspaceId: "ws-1",
  currentFileAbsPath: "/workspace/proj/docs/README.md",
  workspaceRootAbsPath: "/workspace/proj",
};

describe("task checkboxes", () => {
  const source = "- [ ] todo\n- [x] done\n";

  test("interactive when onToggleTask is provided (enabled + tagged)", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} onToggleTask={() => {}} />,
    );
    expect(html).toContain("md-task-checkbox");
    // Interactive checkboxes are not disabled.
    expect(html).not.toContain("disabled");
  });

  test("disabled when onToggleTask is absent (read-only file)", () => {
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("md-task-checkbox");
    expect(html).toContain("disabled");
  });
});

describe("headings", () => {
  test("get a rehype-slug id plus anchor-copy and fold buttons", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={"# Hello World\n\nbody\n"} />,
    );
    expect(html).toContain('id="hello-world"');
    expect(html).toContain("md-heading-anchor");
    expect(html).toContain("md-heading-fold");
  });
});

describe("code blocks", () => {
  test("are wrapped with a copy button", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={"```\nconst x = 1;\n```\n"} />,
    );
    expect(html).toContain("md-code-wrap");
    expect(html).toContain("md-code-copy");
  });
});
