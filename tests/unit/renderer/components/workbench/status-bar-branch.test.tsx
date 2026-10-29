import { afterAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;
// Window IPC stub — the status bar's stores check for window.ipc on import.
globals.window ??= {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
};

afterAll(() => {
  globals.window = originalWindow;
});

const { BranchSegment } = await import(
  "../../../../../src/renderer/components/workbench/status-bar"
);

describe("BranchSegment without a branch", () => {
  test("says no git for a folder that is not a repository", () => {
    const html = renderToStaticMarkup(<BranchSegment workspaceId="ws" branchInfo={null} />);

    expect(html).toContain("no git");
    expect(html).toContain('title="No git repository"');
  });

  test("says git is not installed when the host has no Git", () => {
    const html = renderToStaticMarkup(
      <BranchSegment workspaceId="ws" branchInfo={null} gitMissing />,
    );

    expect(html).toContain("git not installed");
    expect(html).toContain('title="Git is not installed"');
  });
});
