import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

const tempDirs: string[] = [];
const ipcMain = {
  handle: mock(() => undefined),
  removeHandler: mock(() => undefined),
};
const originalResourcesPath = process.resourcesPath;

mock.module("electron", () => ({
  app: {
    getPath: () => tempDirs[0] ?? os.tmpdir(),
    getAppPath: () => path.join(tempDirs[0] ?? os.tmpdir(), "packages", "app"),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain,
}));

afterEach(async () => {
  ipcMain.handle.mockClear();
  ipcMain.removeHandler.mockClear();
  Object.defineProperty(process, "resourcesPath", {
    value: originalResourcesPath,
    configurable: true,
  });

  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("composeElectronAppServices", () => {
  test("SidecarBridge를 SidecarRuntime으로 주입한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "nexus-composition-"));
    tempDirs.push(tempDir);
    Object.defineProperty(process, "resourcesPath", {
      value: path.join(tempDir, "resources"),
      configurable: true,
    });

    const { composeElectronAppServices } = await import("./electron-app-composition");
    const { SidecarBridge } = await import("./sidecar-bridge");
    const mainWindow = createMainWindowMock();

    const services = await composeElectronAppServices(mainWindow);

    try {
      expect(services.sidecarRuntime).toBeInstanceOf(SidecarBridge);
    } finally {
      await services.dispose();
    }
  });
});

function createMainWindowMock(): BrowserWindow {
  const webContents = {
    send: mock(() => undefined),
    on: mock(() => undefined),
    off: mock(() => undefined),
    isDestroyed: () => false,
  };

  return {
    webContents,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
}
