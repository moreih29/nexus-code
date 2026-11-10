/**
 * Scenario tests for push guardrail banner copy and actions.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPushGuardBannerView,
  type PushGuardPendingRetry,
} from "../../../../../../src/renderer/components/files/git/utils/push-guard-banner";
import type { GitStoreError } from "../../../../../../src/renderer/state/stores/git";

const pending: PushGuardPendingRetry = {
  branch: "main",
  attemptedAt: 1_700_000_000_000,
  originalPushOpts: {},
};

describe("buildPushGuardBannerView", () => {
  it("shows Pull / Force / Cancel for non-fast-forward push failures", () => {
    const view = buildPushGuardBannerView({
      error: error("non-fast-forward", "raw non-ff stderr", "raw non-ff stderr"),
      pendingNonFFRetry: pending,
      inFlightKind: null,
    });

    expect(view?.message).toBe("Remote has commits you don't have. Pull first?");
    expect(view?.actions.map((action) => action.kind)).toEqual(["pull", "force", "cancel"]);
  });

  it("shows Fetch for force-with-lease rejections", () => {
    const view = buildPushGuardBannerView({
      error: error("force-push-rejected", "lease stale", "lease stale"),
      pendingNonFFRetry: pending,
      inFlightKind: null,
    });

    expect(view?.message).toBe("Force push rejected (lease check failed) — Fetch first?");
    expect(view?.actions.map((action) => action.kind)).toEqual(["fetch"]);
  });
});

/** Creates the renderer's normalized Git error shape. */
function error(kind: string, message: string, details?: string): GitStoreError {
  return { kind, message, details, operation: "push" };
}
