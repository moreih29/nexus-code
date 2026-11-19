import { expect, jest, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createIpcPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
  setupInMemoryRouter,
} from "../../../../helpers/ipc-pair";

let appPath: string;
const sent = Promise.withResolvers<void>();
const child = Object.assign(new EventEmitter(), {
  kill: mock(() => true),
  postMessage: mock(() => sent.resolve()),
});

mock.module("electron", () => ({
  app: { isPackaged: false, getAppPath: () => appPath },
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: mockGetAllWebContents },
  utilityProcess: { fork: () => child },
}));

const { registerNotesChannel } = await import("../../../../../src/main/features/notes");

test("notes shutdown stops its voice worker and settles an outstanding request", async () => {
  jest.useFakeTimers();
  appPath = await mkdtemp(path.join(tmpdir(), "notes-shutdown-"));
  try {
    const models = path.join(appPath, "resources", "voice-print");
    await mkdir(models, { recursive: true });
    await writeFile(path.join(models, "campp-zh-en.onnx"), "");
    await setupInMemoryRouter();
    const notes = registerNotesChannel({ userData: appPath, workspaces: () => [] });
    const pair = createIpcPair();
    const result = pair.window.ipc.call("notes", "voicePrint", {
      audio: new Float32Array([0.5]),
    });
    await sent.promise;
    notes.dispose();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ ok: true, value: null });
  } finally {
    child.emit("exit", 0);
    resetInMemoryIpc();
    jest.useRealTimers();
    await rm(appPath, { recursive: true, force: true });
  }
});

test("notes shutdown waits for a save started by a renderer that has closed", async () => {
  await setupInMemoryRouter();
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const notes = registerNotesChannel({
    userData: "/unused",
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
  const finishedWrite = Promise.withResolvers<void>();
  const startedWrite = Promise.withResolvers<void>();
  const save = spyOn(notes.store, "save").mockImplementation(async () => {
    startedWrite.resolve();
    await finishedWrite.promise;
    return { title: "Kept" } as never;
  });
  const pair = createIpcPair();
  const saving = pair.window.ipc.call("notes", "save", {
    workspaceId: id,
    noteId: "n000000note",
    title: "Kept",
  });
  await startedWrite.promise;
  pair.sender.destroy();
  let done = false;
  const drained = notes.waitForWrites().then(() => {
    done = true;
  });
  try {
    await Promise.resolve();
    expect(done).toBe(false);
  } finally {
    finishedWrite.resolve();
    await drained;
    expect(await saving).toMatchObject({ ok: true });
    save.mockRestore();
    notes.dispose();
    resetInMemoryIpc();
  }
});
