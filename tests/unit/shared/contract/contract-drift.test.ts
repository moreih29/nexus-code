/**
 * IPC contract drift guards
 *
 * The other contract tests in this directory parse hand-crafted objects with
 * zod and assert that valid shapes pass / invalid shapes fail. They verify
 * that zod is wired up — they do NOT verify that real handlers actually
 * produce values matching their declared schemas.
 *
 * This file closes that gap for the channels that move user data:
 *   - fs.readdir / fs.stat / fs.readFile  → exercised against a real tmp tree
 *   - workspace.create / workspace.list   → exercised against real
 *     GlobalStorage + WorkspaceStorage + StateService
 *
 * Each test runs the production handler, takes the raw return value, and
 * pushes it through the contract's `result` schema via `safeParse`. If the
 * handler ever drifts away from the declared shape (extra/missing fields,
 * wrong enum value, wrong type), `safeParse` fails and the test surfaces
 * the exact zod issue.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readdirHandler,
  readFileHandler,
  statHandler,
} from "../../../../src/main/ipc/channels/fs/read-handlers";
import { GlobalStorage } from "../../../../src/main/storage/global-storage";
import { StateService } from "../../../../src/main/storage/state-service";
import { WorkspaceStorage } from "../../../../src/main/storage/workspace-storage";
import { WorkspaceManager } from "../../../../src/main/workspace/workspace-manager";
import { ipcContract } from "../../../../src/shared/ipc-contract";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-contract-drift-"));
}

function makeFsManagerStub(rootPath: string): { list: () => WorkspaceMeta[] } {
  return {
    list: () => [
      {
        id: VALID_UUID,
        name: "drift-ws",
        rootPath,
        colorTone: "default",
        pinned: false,
        lastOpenedAt: new Date().toISOString(),
        tabs: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// fs channel — handler outputs vs ipcContract.fs.call.*.result
// ---------------------------------------------------------------------------

describe("ipcContract drift — fs handlers", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("readdir handler output matches fs.readdir.result schema", async () => {
    fs.writeFileSync(path.join(tmpRoot, "a.txt"), "hi");
    fs.mkdirSync(path.join(tmpRoot, "subdir"));
    fs.writeFileSync(path.join(tmpRoot, "subdir", "b.txt"), "deep");

    const handler = readdirHandler(makeFsManagerStub(tmpRoot) as never);
    const entries = await handler({ workspaceId: VALID_UUID, relPath: "" });

    const parsed = ipcContract.fs.call.readdir.result.safeParse(entries);
    if (!parsed.success) {
      throw new Error(`readdir output failed schema:\n${parsed.error.toString()}`);
    }
  });

  it("stat handler output matches fs.stat.result schema (file)", async () => {
    fs.writeFileSync(path.join(tmpRoot, "x.txt"), "abc");

    const handler = statHandler(makeFsManagerStub(tmpRoot) as never);
    const stat = await handler({ workspaceId: VALID_UUID, relPath: "x.txt" });

    const parsed = ipcContract.fs.call.stat.result.safeParse(stat);
    if (!parsed.success) {
      throw new Error(`stat output failed schema:\n${parsed.error.toString()}`);
    }
  });

  it("readFile handler output matches fs.readFile.result schema (utf-8 text)", async () => {
    fs.writeFileSync(path.join(tmpRoot, "ok.txt"), "hello world\n");

    const handler = readFileHandler(makeFsManagerStub(tmpRoot) as never);
    const content = await handler({ workspaceId: VALID_UUID, relPath: "ok.txt" });

    const parsed = ipcContract.fs.call.readFile.result.safeParse(content);
    if (!parsed.success) {
      throw new Error(`readFile output failed schema:\n${parsed.error.toString()}`);
    }
  });

  it("readFile handler output matches schema for binary detection (null byte)", async () => {
    const binPath = path.join(tmpRoot, "bin.dat");
    fs.writeFileSync(binPath, Buffer.from([0x48, 0x00, 0x69]));

    const handler = readFileHandler(makeFsManagerStub(tmpRoot) as never);
    const content = await handler({ workspaceId: VALID_UUID, relPath: "bin.dat" });

    const parsed = ipcContract.fs.call.readFile.result.safeParse(content);
    if (!parsed.success) {
      throw new Error(`readFile (binary) output failed schema:\n${parsed.error.toString()}`);
    }
    expect(content.isBinary).toBe(true);
  });

  it("readFile handler output matches schema for utf-8 BOM file", async () => {
    const bomPath = path.join(tmpRoot, "bom.txt");
    fs.writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));

    const handler = readFileHandler(makeFsManagerStub(tmpRoot) as never);
    const content = await handler({ workspaceId: VALID_UUID, relPath: "bom.txt" });

    const parsed = ipcContract.fs.call.readFile.result.safeParse(content);
    if (!parsed.success) {
      throw new Error(`readFile (BOM) output failed schema:\n${parsed.error.toString()}`);
    }
    expect(content.encoding).toBe("utf8-bom");
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeManager(): WorkspaceManager {
    const wsBaseDir = path.join(tmpRoot, "workspaces");
    fs.mkdirSync(wsBaseDir, { recursive: true });
    const globalStorage = new GlobalStorage(new Database(":memory:"));
    const workspaceStorage = new WorkspaceStorage(wsBaseDir, (p) => new Database(p));
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
