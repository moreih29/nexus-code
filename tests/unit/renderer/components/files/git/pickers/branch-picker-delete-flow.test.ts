import { describe, expect, it, mock } from "bun:test";
import {
  type BranchDeleteRequest,
  buildBranchDeleteDialogView,
  confirmBranchDelete,
} from "../../../../../../../src/renderer/components/files/git/branch/picker";
import { createBranchPickerSource } from "../../../../../../../src/renderer/components/files/git/branch/picker-source";

it("offers branch creation when opened with the legacy checkout mode", async () => {
  const createBranch = mock(async () => {});
  const source = createBranchPickerSource({
    workspaceId: "ws-1",
    mode: "checkout",
    listBranches: async () => ({ current: null, local: [], remote: [] }),
    checkout: async () => {},
    checkoutTracking: async () => {},
    createBranch,
  });

  const items = await source.search("feature", new AbortController().signal);

  expect(items.map((item) => item.action)).toEqual([{ kind: "create-branch", name: "feature" }]);
  await source.accept(items[0]);
  expect(createBranch.mock.calls).toEqual([["ws-1", "feature", true]]);
});

describe("BranchPicker delete confirmation flow", () => {
  it("deletes a fully merged local branch without force after one confirmation", async () => {
    const deleteBranch = mock(async () => {});
    const deleteRemoteBranch = mock(async () => {});
    const asked = confirmations(true);

    await confirmBranchDelete(
      { kind: "local", name: "feature", force: false },
      { workspaceId: "ws-1", deleteBranch, deleteRemoteBranch, confirm: asked.confirm },
    );

    expect(asked.requests).toEqual([{ kind: "local", name: "feature", force: false }]);
    expect(deleteBranch.mock.calls).toEqual([["ws-1", "feature", false]]);
    expect(deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const deleteBranch = mock(async () => {});
    const asked = confirmations(false);

    await confirmBranchDelete(
      { kind: "local", name: "feature", force: false },
      {
        workspaceId: "ws-1",
        deleteBranch,
        deleteRemoteBranch: async () => {},
        confirm: asked.confirm,
      },
    );

    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("asks again with a force warning when the branch is not fully merged, then retries force=true", async () => {
    const deleteBranch = mock(async (_workspaceId: string, _name: string, force?: boolean) => {
      if (force !== true) {
        throw { kind: "branch-not-fully-merged", message: "not fully merged" };
      }
    });
    const asked = confirmations(true, true);

    await confirmBranchDelete(
      { kind: "local", name: "feature", force: false },
      {
        workspaceId: "ws-1",
        deleteBranch,
        deleteRemoteBranch: async () => {},
        confirm: asked.confirm,
      },
    );

    expect(asked.requests).toEqual([
      { kind: "local", name: "feature", force: false },
      { kind: "local", name: "feature", force: true },
    ]);
    expect(buildBranchDeleteDialogView(asked.requests[1])).toEqual({
      title: "Branch is not fully merged",
      description: [
        "Branch 'feature' is not fully merged.",
        "Delete anyway? Unmerged commits may be lost.",
      ],
      confirmLabel: "Delete",
      forceWarning: true,
    });
    expect(deleteBranch.mock.calls).toEqual([
      ["ws-1", "feature", false],
      ["ws-1", "feature", true],
    ]);
  });

  it("does not delete with force when the force warning is cancelled", async () => {
    const deleteBranch = mock(async (_workspaceId: string, _name: string, force?: boolean) => {
      if (force !== true) {
        throw { kind: "branch-not-fully-merged", message: "not fully merged" };
      }
    });
    const asked = confirmations(true, false);

    await confirmBranchDelete(
      { kind: "local", name: "feature", force: false },
      {
        workspaceId: "ws-1",
        deleteBranch,
        deleteRemoteBranch: async () => {},
        confirm: asked.confirm,
      },
    );

    expect(deleteBranch.mock.calls).toEqual([["ws-1", "feature", false]]);
  });

  it("does not offer force delete on an error name alone", async () => {
    const asked = confirmations(true, true);
    await confirmBranchDelete(
      { kind: "local", name: "feature", force: false },
      {
        workspaceId: "ws-1",
        deleteBranch: async () => {
          throw Object.assign(new Error("delete failed"), { name: "branch-not-fully-merged" });
        },
        deleteRemoteBranch: async () => {},
        confirm: asked.confirm,
      },
    );
    expect(asked.requests).toHaveLength(1);
  });

  it("routes remote delete confirmation to deleteRemoteBranch", async () => {
    const deleteBranch = mock(async () => {});
    const deleteRemoteBranch = mock(async () => {});

    await confirmBranchDelete(
      { kind: "remote", remote: "origin", name: "feature" },
      {
        workspaceId: "ws-1",
        deleteBranch,
        deleteRemoteBranch,
        confirm: confirmations(true).confirm,
      },
    );

    expect(deleteRemoteBranch.mock.calls).toEqual([["ws-1", "origin", "feature"]]);
    expect(deleteBranch).not.toHaveBeenCalled();
  });
});

function confirmations(...answers: boolean[]): {
  requests: BranchDeleteRequest[];
  confirm: (request: BranchDeleteRequest) => Promise<boolean>;
} {
  const requests: BranchDeleteRequest[] = [];
  return {
    requests,
    confirm: async (request) => {
      requests.push(request);
      return answers[requests.length - 1] ?? false;
    },
  };
}
