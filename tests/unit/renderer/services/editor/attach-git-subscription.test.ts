import { describe, expect, mock, test } from "bun:test";
import {
  attachGitSubscription,
  type AttachGitSubscriptionDeps,
} from "../../../../../src/renderer/services/editor/model/attach-git-subscription";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTRY = { input: { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" } };

function makeDeps(
  onSubscribe?: () => void,
): [AttachGitSubscriptionDeps, { fireChanged: () => void }] {
  let capturedCallback: (() => void) | null = null;

  const deps: AttachGitSubscriptionDeps = {
    subscribeGitStatusChanged: mock((_input, callback) => {
      capturedCallback = callback;
      onSubscribe?.();
      return () => {
        capturedCallback = null;
      };
    }),
  };

  return [
    deps,
    {
      fireChanged: () => {
        capturedCallback?.();
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachGitSubscription — subscription wiring", () => {
  test("subscribes to git.statusChanged for the entry's workspace", () => {
    const [deps] = makeDeps();
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);
    expect(deps.subscribeGitStatusChanged).toHaveBeenCalledWith(ENTRY.input, expect.any(Function));
    unsubscribe();
  });

  test("debounces rapid git.statusChanged events into a single onChanged call", async () => {
    const [deps, ctl] = makeDeps();
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);

    // Fire three events in rapid succession.
    ctl.fireChanged();
    ctl.fireChanged();
    ctl.fireChanged();

    // Allow the debounce timer to fire.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("does not call onChanged after unsubscribe cancels the timer", async () => {
    const [deps, ctl] = makeDeps();
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);

    // Fire an event then immediately unsubscribe before the debounce timer fires.
    ctl.fireChanged();
    unsubscribe();

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onChanged).not.toHaveBeenCalled();
  });

  test("unsubscribe removes the git.statusChanged listener", () => {
    const [deps, ctl] = makeDeps();
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);
    unsubscribe();

    // After unsubscribe the internal capturedCallback is cleared, so a
    // subsequent fireChanged is a no-op and onChanged never runs.
    ctl.fireChanged();

    expect(onChanged).not.toHaveBeenCalled();
  });
});
