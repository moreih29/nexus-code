/**
 * Scenario tests for GitPanel helper copy that guards multi-remote footguns
 * and tag-to-History reveal behavior.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPublishBranchPrompt,
  buildTagHistoryRevealMessage,
  tagHistoryRef,
} from "../../../../../../src/renderer/components/files/git/panel/git-panel-actions";
import type { Tag } from "../../../../../../src/shared/types/git";

describe("buildPublishBranchPrompt", () => {
  it("renders multi-remote publish as confirm-only copy for the first configured remote", () => {
    const prompt = buildPublishBranchPrompt("feature/git-ui", ["upstream", "origin"]);

    expect(prompt).toMatchObject({
      title: "Publish branch?",
      confirmLabel: "Publish",
      inputMode: "none",
    });
    expect(prompt?.label).toBeUndefined();
    expect(prompt?.defaultValue).toBeUndefined();
    expect(prompt?.description).toContain("Publish to 'upstream'?");
    expect(prompt?.description).toContain("origin will not be used");
  });

  it("does not build a publish prompt without a configured remote", () => {
    expect(buildPublishBranchPrompt("main", [])).toBeNull();
  });
});

describe("tag History reveal helpers", () => {
  it("targets the shipped History panel with a full tag ref and current copy", () => {
    const tag = tagFixture();

    expect(tagHistoryRef(tag)).toBe("refs/tags/v1.0.0");
    const message = buildTagHistoryRevealMessage(tag);
    expect(message).toBe("Showing History for tag 'v1.0.0' at 0123456.");
    expect(message).not.toContain("when History lands");
    expect(message).not.toContain("future");
  });
});

/** Returns a minimal annotated tag fixture. */
function tagFixture(): Tag {
  return {
    name: "v1.0.0",
    sha: "0123456789abcdef0123456789abcdef01234567",
    message: "release",
    type: "annotated",
    taggerDate: 1_700_000_000_000,
  };
}
