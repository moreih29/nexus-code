/**
 * Scenario tests for workflow OperationBanner messages and accessibility.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildOperationBannerView,
  OperationBanner,
} from "../../../../../../src/renderer/components/files/git/panel/OperationBanner";
import type { GitOperationState } from "../../../../../../src/shared/types/git";

describe("buildOperationBannerView", () => {
  it("covers merge conflict and resolved states", () => {
    expect(view(mergeState(2)).message).toBe("Merging feature into main — 2 conflicts remain");
    expect(view(mergeState(0)).message).toBe("Merge ready to continue");
  });

  it("covers rebase progress without rendering unknown totals as step ?/?", () => {
    const withProgress = view({
      kind: "rebase",
      variant: "merge",
      headRef: "topic",
      ontoRef: "main",
      doneCount: 3,
      totalCount: 7,
      conflictCount: 1,
      currentCommitSubject: "Replay auth change",
    });
    expect(withProgress.message).toBe("Rebasing onto main — step 3 of 7 · 1 conflict remains");
    expect(withProgress.details).toBe("Replay auth change");

    const unknownTotal = view({
      kind: "rebase",
      variant: "apply",
      headRef: "topic",
      ontoRef: "main",
      doneCount: 0,
      totalCount: 0,
      conflictCount: 1,
    });
    expect(unknownTotal.message).toBe("Rebasing onto main · 1 conflict remains");
    expect(unknownTotal.message).not.toContain("?/?");
  });

  it("covers cherry-pick clean/conflict and failed states", () => {
    expect(
      view({
        kind: "cherry-pick",
        sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceSubject: "Fix button",
        conflictCount: 2,
      }).message,
    ).toBe("Cherry-picking aaaaaaa — 2 conflicts remain");
    expect(view({ kind: "cherry-pick", sourceSha: "aaaaaaaa", conflictCount: 0 }).message).toBe(
      "Cherry-pick ready to continue",
    );

    const failed = buildOperationBannerView(mergeState(0), {
      kind: "unresolved-conflicts",
      message: "Continue failed",
      operation: "continueOp",
    });
    expect(failed.role).toBe("alert");
    expect(failed.continueLabel).toBe("Retry");
  });
});

describe("OperationBanner accessibility", () => {
  it("uses status role and aria-disabled Continue while conflicts remain", () => {
    const html = renderToStaticMarkup(
      <OperationBanner state={mergeState(2)} onContinue={() => {}} onAbort={() => {}} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Resolve 2 conflicts first.");
  });
});

function view(state: Exclude<GitOperationState, { kind: "none" }>) {
  return buildOperationBannerView(state);
}

function mergeState(conflictCount: number): Exclude<GitOperationState, { kind: "none" }> {
  return {
    kind: "merge",
    headRef: "main",
    mergeRef: "feature",
    conflictCount,
  };
}
