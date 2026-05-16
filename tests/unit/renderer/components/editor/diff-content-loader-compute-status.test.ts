/**
 * Unit tests for computeStatus and REFRESHING_INDICATOR_DELAY_MS in
 * diff-content-loader.ts.
 *
 * SCOPE:
 *   1. computeStatus transitions: loading / refreshing / ready / error.
 *   2. REFRESHING_INDICATOR_DELAY_MS is exported and equals 400.
 *
 * ISOLATION: computeStatus is a pure function that only inspects DiffSideState
 * shapes — no IPC or React hooks involved.  No mocks are required.
 *
 * The ipc/client mock is registered as a leaf-module mock (Rule 1) solely so
 * that importing diff-content-loader does not throw at module load time
 * (ipcListen/ipcCall are called at hook invocation, not at import time, but
 * the module references the import at the top level).
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock ipc/client as a leaf module BEFORE importing the module under test.
// ---------------------------------------------------------------------------
const realIpcClient = await import("../../../../../src/renderer/ipc/client");

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCall: mock(() => Promise.resolve(null)),
  ipcListen: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mock.module.
// ---------------------------------------------------------------------------
import {
  computeStatus,
  type DiffSideErrorState,
  type DiffSideLoadingState,
  type DiffSideReadyState,
  type DiffSideRequest,
  REFRESHING_INDICATOR_DELAY_MS,
} from "../../../../../src/renderer/components/editor/diff-content-loader";

// ---------------------------------------------------------------------------
// Helpers to build minimal DiffSideState fixtures.
// ---------------------------------------------------------------------------

const baseRequest: DiffSideRequest = {
  side: "left",
  workspaceId: "ws-test",
  relPath: "src/foo.ts",
  ref: "HEAD",
  source: "git",
};

const rightRequest: DiffSideRequest = { ...baseRequest, side: "right", ref: "WORKING" };

function readyState(side: "left" | "right" = "left"): DiffSideReadyState {
  return {
    phase: "ready",
    request: side === "left" ? baseRequest : rightRequest,
    content: "const x = 1;\n",
    encoding: "utf8",
    sizeBytes: 14,
    isBinary: false,
    mtime: "2024-01-01T00:00:00.000Z",
  };
}

function loadingState(
  side: "left" | "right" = "left",
  previous?: DiffSideReadyState,
): DiffSideLoadingState {
  return {
    phase: "loading",
    request: side === "left" ? baseRequest : rightRequest,
    ...(previous ? { previous } : {}),
  };
}

function errorState(side: "left" | "right" = "left"): DiffSideErrorState {
  return {
    phase: "error",
    request: side === "left" ? baseRequest : rightRequest,
    message: "Something went wrong",
    tooLarge: false,
  };
}

// ---------------------------------------------------------------------------
// Tests — REFRESHING_INDICATOR_DELAY_MS exported constant
// ---------------------------------------------------------------------------

describe("REFRESHING_INDICATOR_DELAY_MS", () => {
  test("is exported and equals 400", () => {
    expect(REFRESHING_INDICATOR_DELAY_MS).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests — computeStatus transitions
// ---------------------------------------------------------------------------

describe("computeStatus", () => {
  test('returns "loading" when both sides have no previous content', () => {
    expect(computeStatus(loadingState("left"), loadingState("right"))).toBe("loading");
  });

  test('returns "loading" when left is loading without previous and right is ready', () => {
    expect(computeStatus(loadingState("left"), readyState("right"))).toBe("loading");
  });

  test('returns "loading" when left is ready and right is loading without previous', () => {
    expect(computeStatus(readyState("left"), loadingState("right"))).toBe("loading");
  });

  test('returns "refreshing" when both sides are loading and both have previous content', () => {
    const leftPrev = readyState("left");
    const rightPrev = readyState("right");
    expect(computeStatus(loadingState("left", leftPrev), loadingState("right", rightPrev))).toBe(
      "refreshing",
    );
  });

  test('returns "refreshing" when left is loading with previous and right is ready', () => {
    const leftPrev = readyState("left");
    expect(computeStatus(loadingState("left", leftPrev), readyState("right"))).toBe("refreshing");
  });

  test('returns "refreshing" when right is loading with previous and left is ready', () => {
    const rightPrev = readyState("right");
    expect(computeStatus(readyState("left"), loadingState("right", rightPrev))).toBe("refreshing");
  });

  test('returns "loading" when one side is loading with previous but the other is loading without previous', () => {
    // Both sides must have displayable content to qualify as "refreshing".
    const leftPrev = readyState("left");
    expect(computeStatus(loadingState("left", leftPrev), loadingState("right"))).toBe("loading");
  });

  test('returns "ready" when both sides are ready', () => {
    expect(computeStatus(readyState("left"), readyState("right"))).toBe("ready");
  });

  test('returns "error" when left side has an error', () => {
    expect(computeStatus(errorState("left"), readyState("right"))).toBe("error");
  });

  test('returns "error" when right side has an error', () => {
    expect(computeStatus(readyState("left"), errorState("right"))).toBe("error");
  });

  test('returns "error" when both sides have an error', () => {
    expect(computeStatus(errorState("left"), errorState("right"))).toBe("error");
  });

  test('"error" takes precedence over "loading"', () => {
    // An error on one side should not be masked by the other side still loading.
    expect(computeStatus(errorState("left"), loadingState("right"))).toBe("error");
  });
});
