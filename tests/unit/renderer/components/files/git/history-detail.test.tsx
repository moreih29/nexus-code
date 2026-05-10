/**
 * Scenario tests for History detail rendering.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitDetailContent } from "../../../../../../src/renderer/components/files/git/history/HistoryDetail";
import type { CommitDetail } from "../../../../../../src/shared/types/git";

describe("CommitDetailContent", () => {
  it("renders merge label and suppresses file list for merge commits", () => {
    const detail: CommitDetail = {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: [
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccccccccccc",
      ],
      subject: "Merge feature",
      author: "Ada",
      authorEmail: "ada@example.invalid",
      committerTs: "2026-05-10T00:00:00.000Z",
      message: "Merge feature",
      body: "",
      files: [],
    };

    const html = renderToStaticMarkup(<CommitDetailContent detail={detail} />);

    expect(html).toContain("Merge commit (2 parents)");
    expect(html).not.toContain("Files changed");
  });

  it("renders body and changed file paths for ordinary commits", () => {
    const detail: CommitDetail = {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      subject: "fix popover",
      author: "Ada",
      authorEmail: "ada@example.invalid",
      committerTs: "2026-05-10T00:00:00.000Z",
      message: "fix popover\n\nbody line",
      body: "body line",
      files: [{ status: "M", path: "src/popover.tsx" }],
    };

    const html = renderToStaticMarkup(<CommitDetailContent detail={detail} />);

    expect(html).toContain("body line");
    expect(html).toContain("Files changed (1)");
    expect(html).toContain("src/popover.tsx");
  });
});
