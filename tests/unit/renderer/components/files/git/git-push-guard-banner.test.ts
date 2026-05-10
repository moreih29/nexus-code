/**
 * Scenario tests for push guardrail banner copy and actions.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPushGuardBannerView,
  type PushGuardPendingRetry,
} from "../../../../../../src/renderer/components/files/git/git-push-guard-banner";
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

  it("shows Retry after the pull in a non-fast-forward retry flow succeeds", () => {
    const view = buildPushGuardBannerView({
      error: null,
      pendingNonFFRetry: pending,
      inFlightKind: null,
    });

    expect(view?.message).toBe("Pulled. Retry push?");
    expect(view?.actions.map((action) => action.kind)).toEqual(["retry"]);
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

  it("surfaces protected-branch stderr verbatim with no actions", () => {
    const stderr =
      "remote: error: GH006: Protected branch update failed for refs/heads/main.\n" +
      "remote: error: protected branch hook declined\n";
    const view = buildPushGuardBannerView({
      error: error("protected-branch", "trimmed fallback", stderr),
      pendingNonFFRetry: null,
      inFlightKind: null,
    });

    expect(view?.variant).toBe("error");
    expect(view?.message).toBe(stderr);
    expect(view?.actions).toEqual([]);
  });

  it("surfaces pre-receive hook stderr verbatim with no actions", () => {
    const stderr = "remote: error: pre-receive hook declined\nerror: failed to push some refs\n";
    const view = buildPushGuardBannerView({
      error: error("pre-receive-hook-rejected", "trimmed fallback", stderr),
      pendingNonFFRetry: null,
      inFlightKind: null,
    });

    expect(view?.variant).toBe("error");
    expect(view?.message).toBe(stderr);
    expect(view?.actions).toEqual([]);
  });
});

/** Creates the renderer's normalized Git error shape. */
function error(kind: string, message: string, details?: string): GitStoreError {
  return { kind, message, details, operation: "push" };
}
