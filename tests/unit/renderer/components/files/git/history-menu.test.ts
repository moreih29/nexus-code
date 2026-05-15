/**
 * Scenario tests for History commit menu scope.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  buildHistoryCommitMenuItems,
  type HistoryCommitMenuActions,
} from "../../../../../../src/renderer/components/files/git/history/commit-menu";
import type { LogEntry } from "../../../../../../src/shared/types/git";

const entry: LogEntry = {
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shortSha: "aaaaaaa",
  parents: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authoredAt: "2026-05-10T00:00:00.000Z",
  subject: "fix popover",
  body: "body",
};

describe("buildHistoryCommitMenuItems", () => {
  it("exposes the MVP actions and no mixed/hard reset options", () => {
    const actions: HistoryCommitMenuActions = {
      cherryPick: mock(() => {}),
      checkoutDetached: mock(() => {}),
      resetSoft: mock(() => {}),
    };
    const requestCheckout = mock(() => {});
    const requestResetSoft = mock(() => {});
    const model = buildHistoryCommitMenuItems(entry, null, actions, {
      requestCheckout,
      requestResetSoft,
    });

    const labels = model.map((item) => (item.kind === "separator" ? "sep" : item.label));
    expect(labels).toEqual([
      "Copy SHA",
      "Copy message",
      "sep",
      "Cherry-pick this commit…",
      "Checkout (detached)…",
      "sep",
      "Reset branch to here (soft)…",
    ]);
    expect(labels.some((label) => /mixed|hard/i.test(label))).toBe(false);

    const checkout = model.find(
      (item) => item.kind === "item" && item.label === "Checkout (detached)…",
    );
    if (!checkout || checkout.kind !== "item") throw new Error("missing checkout item");
    checkout.onSelect();
    expect(requestCheckout).toHaveBeenCalledWith({
      kind: "checkout",
      sha: entry.sha,
      shortSha: "aaaaaaa",
    });

    const reset = model.find(
      (item) => item.kind === "item" && item.label === "Reset branch to here (soft)…",
    );
    if (!reset || reset.kind !== "item") throw new Error("missing reset item");
    reset.onSelect();
    expect(requestResetSoft).toHaveBeenCalledWith({
      kind: "reset-soft",
      sha: entry.sha,
      shortSha: "aaaaaaa",
    });
  });
});
