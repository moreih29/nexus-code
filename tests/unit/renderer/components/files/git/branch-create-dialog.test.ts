/**
 * Scenario tests for Branch ▸ create-branch dialog validation and dispatch.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  branchCreateDialogDescription,
  buildBranchCreateFields,
  submitBranchCreate,
} from "../../../../../../src/renderer/components/files/git/branch/create-dialog";
import { getFormDialogFieldStates } from "../../../../../../src/renderer/components/ui/form-dialog";
import type { BranchList } from "../../../../../../src/shared/git/types";

const branchList: BranchList = {
  current: {
    current: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    isUnborn: false,
  },
  local: ["main", "release"],
  remote: ["origin/main"],
};

describe("BranchCreateDialog validation", () => {
  it("uses existing FormDialog required copy for empty branch names", () => {
    const fields = buildBranchCreateFields({ branchList });
    const [nameState] = getFormDialogFieldStates(fields, { name: "" });

    expect(nameState?.error).toBe("Required");
  });

  it("shows conflict copy for the current branch and other local branches", () => {
    const fields = buildBranchCreateFields({ branchList });
    const current = getFormDialogFieldStates(fields, { name: "main" })[0];
    const existing = getFormDialogFieldStates(fields, { name: "release" })[0];

    expect(current?.error).toBe("Branch 'main' is already current.");
    expect(existing?.error).toBe("A branch named 'release' already exists.");
  });
});

describe("BranchCreateDialog dispatch", () => {
  it("creates and checks out a branch from the current HEAD", async () => {
    const createBranch = mock(
      async (
        _workspaceId: string,
        _name: string,
        _options?: boolean | { checkout?: boolean },
      ) => {},
    );

    await submitBranchCreate({
      workspaceId: "ws-1",
      name: " feature/new ",
      createBranch,
    });

    expect(createBranch.mock.calls).toEqual([["ws-1", "feature/new", { checkout: true }]]);
  });

  it("passes the selected start ref for Create New Branch From", async () => {
    const createBranch = mock(
      async (
        _workspaceId: string,
        _name: string,
        _options?: boolean | { checkout?: boolean; fromRef?: string },
      ) => {},
    );

    await submitBranchCreate({
      workspaceId: "ws-1",
      name: "feature/from-main",
      fromRef: "origin/main",
      createBranch,
    });

    expect(createBranch.mock.calls).toEqual([
      ["ws-1", "feature/from-main", { checkout: true, fromRef: "origin/main" }],
    ]);
    expect(branchCreateDialogDescription({ fromRef: "origin/main" })).toContain("origin/main");
  });
});
