/**
 * Tests for toFsToast — the renderer-side fs error → toast dispatcher.
 *
 * Covers:
 * - NOT_EMPTY → warning severity (ENOTEMPTY user-decision, not system error).
 * - UNSUPPORTED_REMOTE branch introduced for remote workspace detection.
 * - Regression coverage for existing codes.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const toastCalls: Array<{ kind: string; message: string }> = [];

mock.module("../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

const { toFsToast } = await import("../../../../src/renderer/services/fs-mutations/errors");

describe("toFsToast — NOT_EMPTY (ENOTEMPTY warning)", () => {
  beforeEach(() => {
    toastCalls.length = 0;
  });

  it("emits kind=warning for NOT_EMPTY so the toast renders with warning severity", () => {
    toFsToast(new Error("NOT_EMPTY: /repo/dir"), { fallback: "fallback" });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe("warning");
  });

  it("uses the notEmpty override message when provided", () => {
    toFsToast(new Error("NOT_EMPTY: /repo/mydir"), {
      fallback: "Couldn't delete folder.",
      notEmpty: "Folder 'mydir' is not empty. Delete its contents first.",
    });

    expect(toastCalls[0]).toEqual({
      kind: "warning",
      message: "Folder 'mydir' is not empty. Delete its contents first.",
    });
  });

  it("falls back to the default notEmpty message when no override is given", () => {
    toFsToast(new Error("NOT_EMPTY: /repo/dir"), { fallback: "fallback" });

    expect(toastCalls[0]).toEqual({
      kind: "warning",
      message: "Folder is not empty.",
    });
  });
});

describe("toFsToast — UNSUPPORTED_REMOTE", () => {
  beforeEach(() => {
    toastCalls.length = 0;
  });

  it("shows the unsupportedRemote override message when the code is present", () => {
    const wsId = "123e4567-e89b-12d3-a456-426614174000";
    toFsToast(new Error(`UNSUPPORTED_REMOTE: ${wsId}`), {
      fallback: "Couldn't reveal in Finder.",
      unsupportedRemote: "Reveal in Finder is only available for local workspaces.",
    });

    expect(toastCalls).toEqual([
      { kind: "error", message: "Reveal in Finder is only available for local workspaces." },
    ]);
  });

  it("shows the default fallback for UNSUPPORTED_REMOTE when no override is given", () => {
    toFsToast(new Error("UNSUPPORTED_REMOTE: some-id"), { fallback: "fallback" });

    expect(toastCalls).toEqual([
      { kind: "error", message: "Operation not supported for remote workspaces." },
    ]);
  });

  it("falls back to the generic message when no fs code matches", () => {
    toFsToast(new Error("Some unexpected error"), {
      fallback: "Couldn't reveal in Finder.",
      unsupportedRemote: "Reveal in Finder is only available for local workspaces.",
    });

    expect(toastCalls).toEqual([{ kind: "error", message: "Couldn't reveal in Finder." }]);
  });
});

describe("toFsToast — existing code regression", () => {
  beforeEach(() => {
    toastCalls.length = 0;
  });

  it("maps ALREADY_EXISTS and CROSS_DEVICE to error severity (unchanged)", () => {
    toFsToast(new Error("ALREADY_EXISTS: /repo/b.ts"), { fallback: "fallback" });
    toFsToast(new Error("CROSS_DEVICE: /repo/a.ts"), { fallback: "fallback" });

    expect(toastCalls).toEqual([
      { kind: "error", message: "Already exists." },
      { kind: "error", message: "Can't move across filesystems." },
    ]);
  });

  it("maps NOT_EMPTY to warning (not error) while keeping message text", () => {
    toFsToast(new Error("NOT_EMPTY: /repo/dir"), { fallback: "fallback" });

    expect(toastCalls[0].kind).toBe("warning");
    expect(toastCalls[0].message).toBe("Folder is not empty.");
  });
});
