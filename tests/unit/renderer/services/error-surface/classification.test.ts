import { afterAll, beforeAll, expect, test } from "bun:test";
import i18next from "i18next";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import { surfaceError } from "../../../../../src/renderer/services/error-surface/surface-error";
import { toFsToast } from "../../../../../src/renderer/services/fs-mutations/errors";
import { gitStoreErrorFromUnknown } from "../../../../../src/renderer/state/stores/git/store-helpers";
import {
  fileErrorMessage,
  fsErrorReason,
  parseFileErrorCode,
} from "../../../../../src/renderer/utils/file-error";
import { createI18n } from "../../../../../src/shared/i18n";

const previousLanguage = i18next.language;
beforeAll(() => i18next.init(createI18n({ lng: "en" }).options));
afterAll(() => i18next.changeLanguage(previousLanguage ?? "en"));

test("file reads and structured error surfaces keep their own fallback messages", () => {
  const denied = new Error("Error: PERMISSION_DENIED: /secret");
  expect(fileErrorMessage(parseFileErrorCode(denied.message))).toBe("Permission denied.");
  expect(fsErrorReason(denied)).toBe("Permission denied.");
  expect(fileErrorMessage(parseFileErrorCode("STALE: /secret"))).toBe("Failed to open file.");
  expect(fsErrorReason("STALE: /secret")).toBe("STALE: /secret");

  const present = (code: string) =>
    surfaceError(
      { category: "failed", domain: "fs", code, message: "private detail" },
      { surface: "inline" },
    );
  expect(present("PERMISSION_DENIED")).toEqual({
    surface: "inline",
    userMessage: "Permission denied.",
  });
  expect(present("STALE")).toEqual({ surface: "inline", userMessage: "The operation failed." });
});

test("file mutation errors keep warning severity, overrides and fallback for a code without a prefix", () => {
  const toasts: ToastInput[] = [];
  const stop = watchToasts((toast) => toasts.push(toast));
  try {
    toFsToast(new Error("Error: NOT_EMPTY: /folder"), {
      fallback: "Could not remove",
      notEmpty: "Delete contents first",
    });
    toFsToast(new Error("ALREADY_EXISTS: /folder"), {
      fallback: "Could not create",
      alreadyExists: "Choose another name",
    });
    toFsToast(
      { category: "failed", domain: "fs", code: "NOT_FOUND", message: "File gone" },
      { fallback: "Could not remove" },
    );
    expect(toasts).toEqual([
      { kind: "warning", message: "Delete contents first" },
      { kind: "error", message: "Choose another name" },
      { kind: "error", message: "Could not remove" },
    ]);
  } finally {
    stop();
  }
});

test("Git store failures fall back to Error.name and keep distinct stderr", () => {
  const failure = Object.assign(new Error("Could not push"), {
    name: "TransportFailure",
    stderr: "remote refused the update",
  });
  expect(gitStoreErrorFromUnknown(failure, "push")).toMatchObject({
    kind: "TransportFailure",
    message: "Could not push",
    operation: "push",
    details: "remote refused the update",
  });
  expect(
    gitStoreErrorFromUnknown({
      kind: "conflict",
      name: "Error",
      message: "Merge failed",
      stderr: "Merge failed",
    }),
  ).toMatchObject({
    kind: "conflict",
    message: "Merge failed",
    details: undefined,
  });
});
