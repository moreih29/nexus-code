/**
 * Scenario tests for MergeOptionsDialog radio behavior and squash draft copy.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildSquashCommitDraft,
  MergeOptionsDialogContent,
  mergeModeFromOption,
  mergeOptionsSubmitLabel,
} from "../../../../../../src/renderer/components/files/git/pickers/merge-options-dialog";
import type { LogEntry } from "../../../../../../src/shared/git/types";

describe("MergeOptionsDialogContent", () => {
  it("renders three merge radio choices with merge as the default CTA", () => {
    const html = renderToStaticMarkup(
      <MergeOptionsDialogContent
        targetRef="feature/login"
        option="merge-commit"
        onOptionChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Create a merge commit");
    expect(html).toContain("Fast-forward when possible");
    expect(html).toContain("Squash and commit manually");
    expect(html).toContain(">Merge<");
    expect(mergeModeFromOption("merge-commit")).toBe("no-ff");
    expect(mergeModeFromOption("fast-forward")).toBe("default");
  });

  it("shows squash explanatory copy and switches the CTA label", () => {
    const html = renderToStaticMarkup(
      <MergeOptionsDialogContent
        targetRef="feature/login"
        option="squash"
        onOptionChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Squash stages the merged changes");
    expect(html).toContain(">Squash<");
    expect(mergeModeFromOption("squash")).toBe("squash");
    expect(mergeOptionsSubmitLabel("squash")).toBe("Squash");
  });

  it("builds the squash commit draft from the target and commit subjects", () => {
    const draft = buildSquashCommitDraft("feature/login", [
      logEntry("Add login form"),
      logEntry("Wire auth callback"),
    ]);

    expect(draft).toBe("Squash merge of 'feature/login'\n\n* Add login form\n* Wire auth callback");
  });
});

function logEntry(subject: string): LogEntry {
  return {
    sha: `${subject.length}`.padStart(40, "a"),
    shortSha: "aaaaaaa",
    parents: [],
    authorName: "Ada",
    authoredAt: "2026-05-10T00:00:00.000Z",
    subject,
  };
}
