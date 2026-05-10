/**
 * Scenario tests for the Source Control action-button state machine.
 */
import { describe, expect, it } from "bun:test";
import {
  type GitActionButtonInput,
  selectGitActionButton,
} from "../../../../../src/renderer/state/selectors/git-action-button";
import type { BranchInfo, RepoCapabilities } from "../../../../../src/shared/types/git";

const capabilities: RepoCapabilities = {
  hasHEAD: true,
  remotes: ["origin"],
  stashCount: 0,
  tagCount: 0,
};

const mainBranch: BranchInfo = {
  current: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  isUnborn: false,
};

describe("selectGitActionButton", () => {
  it("implements the 11 planned states in top-down order", () => {
    const scenarios: Array<{
      readonly name: string;
      readonly input: Partial<GitActionButtonInput>;
      readonly expectedKind: ReturnType<typeof selectGitActionButton>["kind"];
      readonly expectedLabel: string;
      readonly disabled?: boolean;
    }> = [
      {
        name: "non repo",
        input: { repoKind: "non-repo" },
        expectedKind: "initialize-repository",
        expectedLabel: "Initialize Repository",
      },
      {
        name: "unborn staged draft",
        input: {
          branch: { ...mainBranch, isUnborn: true },
          dirty: dirty({ staged: 1 }),
          commitDraft: "init",
        },
        expectedKind: "make-initial-commit",
        expectedLabel: "Make Initial Commit",
      },
      {
        name: "unborn missing draft",
        input: {
          branch: { ...mainBranch, isUnborn: true },
          dirty: dirty({ staged: 1 }),
          commitDraft: "",
        },
        expectedKind: "commit-disabled",
        expectedLabel: "Commit",
        disabled: true,
      },
      {
        name: "staged draft",
        input: { dirty: dirty({ staged: 1 }), commitDraft: "message" },
        expectedKind: "commit",
        expectedLabel: "Commit",
      },
      {
        name: "unstaged only",
        input: { dirty: dirty({ working: 1 }), commitDraft: "message" },
        expectedKind: "stage-all",
        expectedLabel: "Stage All",
      },
      {
        name: "diverged clean",
        input: { branch: { ...mainBranch, ahead: 2, behind: 3 } },
        expectedKind: "sync",
        expectedLabel: "Sync",
      },
      {
        name: "ahead clean with upstream",
        input: { branch: { ...mainBranch, ahead: 2 } },
        expectedKind: "push",
        expectedLabel: "Push",
      },
      {
        name: "behind clean",
        input: { branch: { ...mainBranch, behind: 2 } },
        expectedKind: "pull",
        expectedLabel: "Pull",
      },
      {
        name: "publishable clean branch",
        input: { branch: { ...mainBranch, upstream: null }, capabilities },
        expectedKind: "publish-branch",
        expectedLabel: "Publish Branch",
      },
      {
        name: "clean without remote",
        input: { capabilities: { ...capabilities, remotes: [] } },
        expectedKind: "no-remote",
        expectedLabel: "No remote configured",
        disabled: true,
      },
      {
        name: "clean up to date",
        input: {},
        expectedKind: "up-to-date",
        expectedLabel: "Up to date",
        disabled: true,
      },
    ];

    for (const scenario of scenarios) {
      const selected = selectGitActionButton(makeInput(scenario.input));
      expect(selected.kind, scenario.name).toBe(scenario.expectedKind);
      expect(selected.label, scenario.name).toBe(scenario.expectedLabel);
      if (scenario.disabled !== undefined)
        expect(selected.disabled, scenario.name).toBe(scenario.disabled);
    }
  });

  it("keeps first match wins when staged draft coexists with remote divergence", () => {
    const selected = selectGitActionButton(
      makeInput({
        branch: { ...mainBranch, ahead: 1, behind: 1 },
        dirty: dirty({ staged: 1 }),
        commitDraft: "commit first",
      }),
    );

    expect(selected.kind).toBe("commit");
  });

  it("keeps staged changes without a draft in a disabled commit state", () => {
    const selected = selectGitActionButton(makeInput({ dirty: dirty({ staged: 1 }) }));

    expect(selected.kind).toBe("commit-disabled");
    expect(selected.label).toBe("Commit");
    expect(selected.disabled).toBe(true);
    expect(selected.staticLabel).toBe(false);
    expect(selected.hint).toBe("Enter a commit message.");
  });

  it("transitions from no remote configured to publish branch after a remote appears", () => {
    const before = selectGitActionButton(
      makeInput({
        branch: { ...mainBranch, upstream: null },
        capabilities: { ...capabilities, remotes: [] },
      }),
    );
    const after = selectGitActionButton(
      makeInput({
        branch: { ...mainBranch, upstream: null },
        capabilities: { ...capabilities, remotes: ["origin"] },
      }),
    );

    expect(before.label).toBe("No remote configured");
    expect(before.disabled).toBe(true);
    expect(after.label).toBe("Publish Branch");
    expect(after.disabled).toBe(false);
  });
});

/** Creates a complete selector input with scenario-specific overrides. */
function makeInput(overrides: Partial<GitActionButtonInput>): GitActionButtonInput {
  return {
    repoKind: "repo",
    capabilities,
    branch: mainBranch,
    dirty: dirty({}),
    commitDraft: "",
    ...overrides,
  };
}

/** Creates dirty counts with zero defaults. */
function dirty(overrides: Partial<GitActionButtonInput["dirty"]>): GitActionButtonInput["dirty"] {
  return { staged: 0, working: 0, untracked: 0, merge: 0, ...overrides };
}
