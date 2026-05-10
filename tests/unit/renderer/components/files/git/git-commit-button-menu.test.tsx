/**
 * Scenario tests for the split commit action chevron menu.
 */
import { describe, expect, it } from "bun:test";
import {
  buildGitCommitMenuModel,
  type GitCommitMenuEnablement,
} from "../../../../../../src/renderer/components/files/git/GitCommitButton";
import type { GitCommitOptions } from "../../../../../../src/shared/types/git";

const enabled: GitCommitMenuEnablement = {
  canCommitStaged: true,
  canCommitAll: true,
  canCommitAndPush: true,
  canPush: true,
  canPull: true,
};

const options: GitCommitOptions = { sign: true, signoff: false, noVerify: true };

describe("buildGitCommitMenuModel", () => {
  it("builds the commit-state menu with commit actions, undo, and sticky options", () => {
    const model = buildGitCommitMenuModel({
      mode: "commit",
      commitOptions: options,
      enablement: enabled,
    });

    expect(labels(model)).toEqual([
      "Commit Staged",
      "Commit All",
      "Amend Last Commit",
      "Commit & Push",
      "Commit Empty",
      "Undo Last Commit",
      "Commit Options",
    ]);

    const submenu = model.find((item) => item.kind === "submenu");
    expect(submenu?.kind).toBe("submenu");
    if (submenu?.kind === "submenu") {
      expect(submenu.items).toEqual([
        { id: "sign", label: "Sign", checked: true },
        { id: "signoff", label: "Signoff", checked: false },
        { id: "noVerify", label: "Skip hooks", checked: true },
      ]);
    }
  });

  it("builds the sync-state menu with Push only and Pull only", () => {
    const model = buildGitCommitMenuModel({
      mode: "sync",
      commitOptions: options,
      enablement: enabled,
    });

    expect(labels(model)).toEqual(["Push only", "Pull only"]);
  });

  it("disables commit and sync menu entries from per-action enablement", () => {
    const commitModel = buildGitCommitMenuModel({
      mode: "commit",
      commitOptions: options,
      enablement: { ...enabled, canCommitStaged: false, canCommitAndPush: false },
    });
    expect(disabledLabels(commitModel)).toEqual(["Commit Staged", "Commit & Push"]);

    const syncModel = buildGitCommitMenuModel({
      mode: "sync",
      commitOptions: options,
      enablement: { ...enabled, canPush: false, canPull: false },
    });
    expect(disabledLabels(syncModel)).toEqual(["Push only", "Pull only"]);
  });
});

/** Collects user-visible labels from top-level menu specs. */
function labels(model: ReturnType<typeof buildGitCommitMenuModel>): string[] {
  return model.filter((item) => item.kind !== "separator").map((item) => item.label);
}

/** Collects disabled labels from top-level item specs. */
function disabledLabels(model: ReturnType<typeof buildGitCommitMenuModel>): string[] {
  return model
    .filter((item) => item.kind === "item" && item.disabled)
    .map((item) => (item.kind === "item" ? item.label : ""));
}
