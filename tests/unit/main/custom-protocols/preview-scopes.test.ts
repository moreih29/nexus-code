import { describe, expect, test } from "bun:test";
import {
  isBroadDir,
  MAX_SCOPES_PER_OWNER,
  PreviewScopes,
} from "../../../../src/main/features/custom-protocols/preview-scopes";

function ids(): () => string {
  let next = 0;
  return () => (next++).toString(16).padStart(32, "0");
}

describe("isBroadDir", () => {
  const home = "/Users/me";

  test("a root, a home, or what holds homes or volumes gives no folder", () => {
    for (const dir of [
      "/",
      "/Users",
      "/Users/me",
      "/Users/me/",
      "/users/ME",
      "/tmp",
      "/home",
      "/home/other",
      "/Volumes/Disk",
      "/mnt/c",
      "/private/tmp",
      "C:/",
      "C:\\",
      "c:/Users",
      "C:/Users/me",
      "D:\\Users\\other",
      "D:/data",
    ]) {
      expect([dir, isBroadDir(dir, home)]).toEqual([dir, true]);
    }
  });

  test("a folder of its own under them gives the folder", () => {
    for (const dir of [
      "/Users/me/reports",
      "/Users/me/reports/q3",
      "/tmp/qa-report",
      "/private/tmp/qa-report",
      "/srv/site/docs",
      "C:/Users/me/Documents",
      "D:/data/report",
    ]) {
      expect([dir, isBroadDir(dir, home)]).toEqual([dir, false]);
    }
  });
});

describe("PreviewScopes", () => {
  test("opens one folder once per window, and none for a broad folder", () => {
    const scopes = new PreviewScopes("/Users/me", ids());
    const id = scopes.open(1, "ws", "/Users/me/r");
    expect(id).not.toBeNull();
    expect(scopes.open(1, "ws", "/Users/me/r/")).toBe(id);
    expect(scopes.open(2, "ws", "/Users/me/r")).not.toBe(id);
    expect(scopes.open(1, "ws", "/Users/me")).toBeNull();
    expect(scopes.open(1, "ws", "relative/dir")).toBeNull();
    expect(scopes.get(id as string)).toEqual({ workspaceId: "ws", dir: "/Users/me/r" });
  });

  test("a window holds only its own folders, and lets go of them all as it closes", () => {
    const scopes = new PreviewScopes("/Users/me", ids());
    const id = scopes.open(1, "ws", "/Users/me/r") as string;
    expect(scopes.heldBy(1, id)).toBe(true);
    expect(scopes.heldBy(2, id)).toBe(false);
    scopes.releaseOwner(1);
    expect(scopes.get(id)).toBeUndefined();
  });

  test("keeps at most so many folders a window, dropping the oldest", () => {
    const scopes = new PreviewScopes("/Users/me", ids());
    const first = scopes.open(1, "ws", "/Users/me/r0") as string;
    for (let i = 1; i <= MAX_SCOPES_PER_OWNER; i++) scopes.open(1, "ws", `/Users/me/r${i}`);
    expect(scopes.size(1)).toBe(MAX_SCOPES_PER_OWNER);
    expect(scopes.get(first)).toBeUndefined();
  });
});
