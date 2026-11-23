import { expect, spyOn, test } from "bun:test";
import { confirmHistoryCommit } from "../../../../../../../src/renderer/components/files/git/history/commit-menu";
import * as confirm from "../../../../../../../src/renderer/components/ui/confirm-dialog";

test("checking out a commit asks with Cancel focused, as resetting does", async () => {
  const ask = spyOn(confirm, "showConfirmDialog").mockResolvedValue(false);
  try {
    await confirmHistoryCommit({ kind: "checkout", sha: "a".repeat(40), shortSha: "aaaaaaa" });
    await confirmHistoryCommit({ kind: "reset-soft", sha: "b".repeat(40), shortSha: "bbbbbbb" });
    const [checkout, reset] = ask.mock.calls.map(([request]) => request);
    expect(checkout?.focus).toBe("cancel");
    expect(checkout?.variant).toBeUndefined();
    expect(reset?.variant).toBe("destructive");
  } finally {
    ask.mockRestore();
  }
});
