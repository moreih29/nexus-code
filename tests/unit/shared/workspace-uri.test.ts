import { describe, expect, test } from "bun:test";
import {
  fileUriToWorkspaceUri,
  parseWorkspaceUri,
  workspaceUriFor,
  workspaceUriToFileUri,
  WORKSPACE_URI_SCHEME,
} from "../../../src/shared/fs/workspace-uri";

const ID = "11111111-2222-3333-4444-555555555555";

describe("workspace URI helpers", () => {
  test("builds nexus-ws scheme with workspaceId authority and encoded path", () => {
    expect(workspaceUriFor(ID, "/workspace/src/main.py")).toBe(
      `${WORKSPACE_URI_SCHEME}://${ID}/workspace/src/main.py`,
    );
  });

  test("percent-encodes spaces and URI-reserved path characters", () => {
    expect(workspaceUriFor(ID, "/workspace with space/src/name#one?.py")).toBe(
      `${WORKSPACE_URI_SCHEME}://${ID}/workspace%20with%20space/src/name%23one%3F.py`,
    );
  });

  test("round-trips through parseWorkspaceUri", () => {
    const path = "/Users/kih/workspaces/projects/max-agent/frontend/src/main.tsx";
    const uri = workspaceUriFor(ID, path);
    const parsed = parseWorkspaceUri(uri);

    expect(parsed).toEqual({ workspaceId: ID, absolutePath: path });
  });

  test("rejects empty workspaceId", () => {
    expect(() => workspaceUriFor("", "/foo")).toThrow();
  });

  test("rejects relative paths", () => {
    expect(() => workspaceUriFor(ID, "relative/path")).toThrow();
  });

  test("parseWorkspaceUri returns null for unrelated URIs", () => {
    expect(parseWorkspaceUri("file:///some/file.ts")).toBeNull();
    expect(parseWorkspaceUri("https://example.com/x")).toBeNull();
    // Authority without a path is invalid (no leading slash for the path).
    expect(parseWorkspaceUri(`${WORKSPACE_URI_SCHEME}://${ID}`)).toBeNull();
  });

  test("workspaceUriToFileUri drops the workspaceId", () => {
    const uri = workspaceUriFor(ID, "/Users/kih/file.tsx");

    expect(workspaceUriToFileUri(uri)).toBe("file:///Users/kih/file.tsx");
  });

  test("workspaceUriToFileUri returns null for non-workspace URIs", () => {
    expect(workspaceUriToFileUri("file:///some/file.ts")).toBeNull();
  });

  test("fileUriToWorkspaceUri lifts a file URI into a workspace scope", () => {
    expect(fileUriToWorkspaceUri(ID, "file:///Users/kih/file.tsx")).toBe(
      `${WORKSPACE_URI_SCHEME}://${ID}/Users/kih/file.tsx`,
    );
  });

  test("two workspaces produce distinct URIs for the same file", () => {
    const other = "99999999-8888-7777-6666-555555555555";

    expect(workspaceUriFor(ID, "/shared/file.tsx")).not.toBe(
      workspaceUriFor(other, "/shared/file.tsx"),
    );
  });
});
