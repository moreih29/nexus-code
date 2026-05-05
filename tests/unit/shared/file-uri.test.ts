import { describe, expect, test } from "bun:test";
import { absolutePathToFileUri, fileUriToAbsolutePath } from "../../../src/shared/file-uri";

describe("file URI helpers", () => {
  test("keeps plain absolute POSIX paths readable", () => {
    expect(absolutePathToFileUri("/workspace/src/main.py")).toBe("file:///workspace/src/main.py");
  });

  test("percent-encodes spaces and URI-reserved path characters by segment", () => {
    const uri = absolutePathToFileUri("/workspace with space/src/name#one?.py");

    expect(uri).toBe("file:///workspace%20with%20space/src/name%23one%3F.py");
  });

  test("round-trips encoded file URIs back to absolute paths", () => {
    const path = "/workspace with space/src/100% typed.py";

    expect(fileUriToAbsolutePath(absolutePathToFileUri(path))).toBe(path);
  });

  test("returns null for non-file URIs", () => {
    expect(fileUriToAbsolutePath("untitled:///scratch.py")).toBeNull();
  });
});
