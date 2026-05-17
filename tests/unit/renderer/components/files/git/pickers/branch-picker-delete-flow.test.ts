/**
 * BranchPicker delete flow tests cover the local force-warning retry and
 * remote delete routing without mounting Radix portal internals.
 */
import { describe, expect, it, mock } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import {
  type BranchDeleteRequest,
  buildBranchDeleteDialogView,
  confirmBranchDelete,
} from "../../../../../../../src/renderer/components/files/git/branch/picker";

describe("BranchPicker delete confirmation flow", () => {
  it("deletes a fully merged local branch without force and closes the request", async () => {
    const deleteBranch = mock(async () => {});
    const deleteRemoteBranch = mock(async () => {});
    const state = deleteState({ kind: "local", name: "feature", force: false });
    const request = state.current;
    if (!request) throw new Error("expected delete request");

    await confirmBranchDelete(request, {
      workspaceId: "ws-1",
      deleteBranch,
      deleteRemoteBranch,
      setDeleteRequest: state.set,
    });

    expect(deleteBranch.mock.calls).toEqual([["ws-1", "feature", false]]);
    expect(deleteRemoteBranch).not.toHaveBeenCalled();
    expect(state.current).toBeNull();
  });

  it("turns not-fully-merged local failures into a warning modal then retries force=true", async () => {
    const deleteBranch = mock(async (_workspaceId: string, _name: string, force?: boolean) => {
      if (force !== true) {
        throw { kind: "branch-not-fully-merged", message: "not fully merged" };
      }
    });
    const deleteRemoteBranch = mock(async () => {});
    const state = deleteState({ kind: "local", name: "feature", force: false });
    const request = state.current;
    if (!request) throw new Error("expected delete request");

    await confirmBranchDelete(request, {
      workspaceId: "ws-1",
      deleteBranch,
      deleteRemoteBranch,
      setDeleteRequest: state.set,
    });

    expect(state.current).toEqual({
      kind: "local",
      name: "feature",
      force: true,
    });
    const warningRequest = state.current;
    if (!warningRequest) throw new Error("expected force warning request");
    const warningView = buildBranchDeleteDialogView(warningRequest);
    expect(warningView).toEqual({
      title: "Branch is not fully merged",
      description: [
        "Branch 'feature' is not fully merged.",
        "Delete anyway? Unmerged commits may be lost.",
      ],
      confirmLabel: "Delete",
      forceWarning: true,
    });

    await confirmBranchDelete(warningRequest, {
      workspaceId: "ws-1",
      deleteBranch,
      deleteRemoteBranch,
      setDeleteRequest: state.set,
    });

    expect(deleteBranch.mock.calls).toEqual([
      ["ws-1", "feature", false],
      ["ws-1", "feature", true],
    ]);
    expect(state.current).toBeNull();
  });

  it("routes remote delete confirmation to deleteRemoteBranch", async () => {
    const deleteBranch = mock(async () => {});
    const deleteRemoteBranch = mock(async () => {});
    const state = deleteState({ kind: "remote", remote: "origin", name: "feature" });
    const request = state.current;
    if (!request) throw new Error("expected delete request");

    await confirmBranchDelete(request, {
      workspaceId: "ws-1",
      deleteBranch,
      deleteRemoteBranch,
      setDeleteRequest: state.set,
    });

    expect(deleteRemoteBranch.mock.calls).toEqual([["ws-1", "origin", "feature"]]);
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(state.current).toBeNull();
  });
});

/**
 * Creates a tiny React setState-compatible holder for delete request tests.
 */
function deleteState(initial: BranchDeleteRequest): {
  current: BranchDeleteRequest | null;
  set: Dispatch<SetStateAction<BranchDeleteRequest | null>>;
} {
  let current: BranchDeleteRequest | null = initial;
  return {
    get current() {
      return current;
    },
    set(value) {
      current = typeof value === "function" ? value(current) : value;
    },
  };
}
