import { expect, test } from "bun:test";
import { __testing } from "../../../../src/renderer/services/editor/preview/link-router";
import { normalizeFilePath } from "../../../../src/renderer/services/editor/tabs/tab-path";
import { isWithinWorkspace } from "../../../../src/shared/fs/workspace-path";

test("preview links discard leading parents and empty path segments", () => {
  expect(__testing.normalizePosix("../../repo/file")).toBe("repo/file");
  expect(__testing.normalizePosix("/repo//src///")).toBe("/repo/src");
  expect(__testing.normalizePosix("./")).toBe("");
});

test("tab lookup keeps unmatched relative parents and trailing slashes", () => {
  expect(normalizeFilePath("../../repo/file")).toBe("../../repo/file");
  expect(normalizeFilePath("/repo//src///")).toBe("/repo/src/");
  expect(normalizeFilePath("./")).toBe("./");
});

test("tab lookup treats a drive letter of either case as one file", () => {
  expect(normalizeFilePath("c:/w/docs/plan.md")).toBe("C:/w/docs/plan.md");
  expect(normalizeFilePath("C:/w/docs/../docs/plan.md")).toBe(
    normalizeFilePath("c:/w/docs/plan.md"),
  );
  expect(normalizeFilePath("c:/w/Docs/plan.md")).not.toBe(normalizeFilePath("C:/w/docs/plan.md"));
});

test("workspace containment keeps repeated separators until the prefix check", () => {
  expect(isWithinWorkspace("../repo/file", "/repo")).toBe(true);
  expect(isWithinWorkspace("/repo/src/", "/repo/src")).toBe(true);
  expect(isWithinWorkspace("/repo//src/file", "/repo/src")).toBe(false);
  expect(isWithinWorkspace("/repo//../outside", "/repo")).toBe(true);
  expect(isWithinWorkspace("/repo/../outside", "/repo")).toBe(false);
});
