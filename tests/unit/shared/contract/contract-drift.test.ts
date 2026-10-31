/**
 * IPC contract drift guards
 *
 * The other contract tests in this directory parse hand-crafted objects with
 * zod and assert that valid shapes pass / invalid shapes fail. They verify
 * that zod is wired up — they do NOT verify that real handlers actually
 * produce values matching their declared schemas.
 *
 * This file closes that gap for workspace.create / workspace.list, exercised
 * against real GlobalStorage + WorkspaceStorage + StateService. (The fs read
 * results come from the Go agent; internal/fs/read_test.go pins those shapes.)
 *
 * Each test runs the production handler, takes the raw return value, and
 * pushes it through the contract's `result` schema via `safeParse`. If the
 * handler ever drifts away from the declared shape (extra/missing fields,
 * wrong enum value, wrong type), `safeParse` fails and the test surfaces
 * the exact zod issue.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import { StateService } from "../../../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";
import { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import { ipcContract } from "../../../../src/shared/ipc/contract";
import { closeTestDatabases, openTestDatabase } from "../../../helpers/test-database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-contract-drift-"));
}

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

// ---------------------------------------------------------------------------
// workspace channel — handler outputs vs ipcContract.workspace.call.*.result
// ---------------------------------------------------------------------------

describe("ipcContract drift — workspace handlers", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    closeTestDatabases();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeManager(): WorkspaceManager {
    const wsBaseDir = path.join(tmpRoot, "workspaces");
    fs.mkdirSync(wsBaseDir, { recursive: true });
    const globalStorage = new GlobalStorage(openTestDatabase(":memory:"));
    const workspaceStorage = new WorkspaceStorage(wsBaseDir, (p) => openTestDatabase(p));
    const stateService = new StateService(path.join(tmpRoot, "state.json"));
    const broadcastFn = mock((_c: string, _e: string, _a: unknown) => {});
    return new WorkspaceManager(globalStorage, workspaceStorage, stateService, broadcastFn);
  }

  it("workspace.create output matches workspace.create.result schema", () => {
    const projectRoot = path.join(tmpRoot, "project");
    fs.mkdirSync(projectRoot, { recursive: true });

    const manager = makeManager();
    const meta = manager.create({ rootPath: projectRoot, name: "drift" });

    const parsed = ipcContract.workspace.call.create.result.safeParse(meta);
    if (!parsed.success) {
      throw new Error(`workspace.create output failed schema:\n${parsed.error.toString()}`);
    }
  });

  it("workspace.list output matches workspace.list.result schema (empty + populated)", () => {
    const manager = makeManager();

    const empty = manager.list();
    let parsed = ipcContract.workspace.call.list.result.safeParse(empty);
    if (!parsed.success) {
      throw new Error(`workspace.list (empty) failed:\n${parsed.error.toString()}`);
    }

    const projectRoot = path.join(tmpRoot, "p");
    fs.mkdirSync(projectRoot, { recursive: true });
    manager.create({ rootPath: projectRoot });

    const populated = manager.list();
    parsed = ipcContract.workspace.call.list.result.safeParse(populated);
    if (!parsed.success) {
      throw new Error(`workspace.list (populated) failed:\n${parsed.error.toString()}`);
    }
  });
});
