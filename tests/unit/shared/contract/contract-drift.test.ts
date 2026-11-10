/**
 * IPC contract drift guards
 *
 * fs mutation calls must name a workspace and a path relative to it: an
 * absolute, drive-letter or UNC path is refused at the IPC boundary.
 */

import { describe, expect, it } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc/contract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

// ---------------------------------------------------------------------------
// fs channel — mutation args
// ---------------------------------------------------------------------------

describe("ipcContract drift — fs mutation args", () => {
  it("requires workspace-scoped relative path args for unlink/rmdir/rename", () => {
    expect(
      ipcContract.fs.call.unlink.args.safeParse({
        workspaceId: VALID_UUID,
        relPath: "old.txt",
      }).success,
    ).toBe(true);
    expect(
      ipcContract.fs.call.rmdir.args.safeParse({
        workspaceId: VALID_UUID,
        relPath: "empty",
      }).success,
    ).toBe(true);
    expect(
      ipcContract.fs.call.rename.args.safeParse({
        workspaceId: VALID_UUID,
        fromRelPath: "old.txt",
        toRelPath: "new.txt",
      }).success,
    ).toBe(true);

    expect(ipcContract.fs.call.unlink.args.safeParse({ relPath: "old.txt" }).success).toBe(false);
    expect(ipcContract.fs.call.rmdir.args.safeParse({ relPath: "empty" }).success).toBe(false);
    expect(
      ipcContract.fs.call.rename.args.safeParse({
        fromRelPath: "old.txt",
        toRelPath: "new.txt",
      }).success,
    ).toBe(false);
    expect(
      ipcContract.fs.call.unlink.args.safeParse({
        workspaceId: VALID_UUID,
        relPath: "/tmp/old.txt",
      }).success,
    ).toBe(false);
    expect(
      ipcContract.fs.call.rmdir.args.safeParse({
        workspaceId: VALID_UUID,
        relPath: "C:\\tmp\\empty",
      }).success,
    ).toBe(false);
    expect(
      ipcContract.fs.call.rename.args.safeParse({
        workspaceId: VALID_UUID,
        fromRelPath: "\\\\server\\share\\old.txt",
        toRelPath: "new.txt",
      }).success,
    ).toBe(false);
  });
});
