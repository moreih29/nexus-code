import { expect, jest, mock, test } from "bun:test";
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
