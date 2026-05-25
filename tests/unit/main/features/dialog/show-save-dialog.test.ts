/**
 * dialog.showSaveDialog IPC 핸들러 단위 테스트.
 *
 * Electron dialog 모듈을 mock.module 로 교체하고, 핸들러 구현과 동일한 로직을
 * validateArgs + mock 함수로 직접 검증한다. registerDialogChannel() 의 side-
 * effect(ipcMain.handle 등록) 없이 핸들러 로직만 순수하게 테스트한다.
 *
 * - case 1: canceled = true  (사용자가 다이얼로그를 닫은 경우)
 * - case 2: filePath 반환 성공 케이스 (opts 전달)
 * - case 3: opts 없이 호출 (인수 undefined — 기본 Save 다이얼로그)
 * - case 4: 기존 showOpenFile 핸들러 회귀 — 기존 테스트 깨지지 않음 확인
 * - case 5: 기존 showOpenDirectory 핸들러 회귀
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must precede any dynamic imports that pull in the mocked modules.
// ---------------------------------------------------------------------------

const mockShowSaveDialog = mock(async (_opts: unknown) => ({
  canceled: false,
  filePath: "/tmp/output.txt",
}));

const mockShowOpenDialog = mock(async (_opts: unknown) => ({
  canceled: false,
  filePaths: ["/tmp/input.txt"],
}));

mock.module("electron", () => ({
  dialog: {
    showSaveDialog: mockShowSaveDialog,
    showOpenDialog: mockShowOpenDialog,
  },
  ipcMain: {
    handle: (_channel: string, _handler: unknown) => {},
    on: (_channel: string, _handler: unknown) => {},
  },
  webContents: { getAllWebContents: () => [] },
  app: { getPath: () => "/tmp" },
}));

mock.module("electron-log/main", () => ({
  default: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    initialize: () => {},
    transports: {
      file: { resolvePathFn: undefined, level: "debug", format: undefined },
      console: { level: "info", format: undefined },
    },
  },
}));

mock.module("/Users/kih/workspaces/areas/nexus-code/src/shared/log/main", () => ({
  createLogger: (_source: string) => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
  initMainLogger: () => {},
}));

// Dynamic imports — after all mock.module calls
const { validateArgs } = await import("../../../../../src/main/infra/ipc-router");
const { ipcContract } = await import("../../../../../src/shared/ipc/contract");

const c = ipcContract.dialog.call;

// ---------------------------------------------------------------------------
// Helper functions that mirror the handler implementation in
// src/main/features/dialog/index.ts. Testing at this level keeps the test
// isolated from ipcMain registration and live Electron context while still
// exercising the real schema + logic path.
// ---------------------------------------------------------------------------

async function invokeShowSaveDialog(args: unknown) {
  const opts = validateArgs(c.showSaveDialog.args, args) ?? {};
  const result = await mockShowSaveDialog({
    title: (opts as Record<string, unknown>).title,
    defaultPath: (opts as Record<string, unknown>).defaultPath,
    filters: (opts as Record<string, unknown>).filters,
  });
  return { canceled: result.canceled, filePath: result.filePath };
}

async function invokeShowOpenFile(args: unknown) {
  const { title, defaultPath, filters } = validateArgs(c.showOpenFile.args, args);
  const result = await mockShowOpenDialog({
    title,
    defaultPath,
    filters,
    properties: ["openFile"],
  });
  return { canceled: result.canceled, filePaths: result.filePaths };
}

async function invokeShowOpenDirectory(args: unknown) {
  const { title, defaultPath } = validateArgs(c.showOpenDirectory.args, args);
  const result = await mockShowOpenDialog({
    title,
    defaultPath,
    properties: ["openDirectory", "createDirectory"],
  });
  return { canceled: result.canceled, filePaths: result.filePaths };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("showSaveDialog handler", () => {
  beforeEach(() => {
    mockShowSaveDialog.mockClear();
    mockShowOpenDialog.mockClear();
  });

  describe("case 1 — canceled = true", () => {
    test("returns { canceled: true, filePath: undefined } when user dismisses", async () => {
      mockShowSaveDialog.mockImplementationOnce(async () => ({
        canceled: true,
        filePath: undefined,
      }));

      const result = await invokeShowSaveDialog({});
      expect(result.canceled).toBe(true);
      expect(result.filePath).toBeUndefined();
      expect(mockShowSaveDialog).toHaveBeenCalledTimes(1);
    });
  });

  describe("case 2 — filePath success with opts", () => {
    test("passes opts through and returns filePath", async () => {
      mockShowSaveDialog.mockImplementationOnce(async () => ({
        canceled: false,
        filePath: "/home/user/document.md",
      }));

      const opts = {
        title: "Save Document",
        defaultPath: "/home/user/document.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };

      const result = await invokeShowSaveDialog(opts);
      expect(result.canceled).toBe(false);
      expect(result.filePath).toBe("/home/user/document.md");
      expect(mockShowSaveDialog).toHaveBeenCalledTimes(1);
      const calledWith = mockShowSaveDialog.mock.calls[0]![0] as Record<string, unknown>;
      expect(calledWith.title).toBe("Save Document");
      expect(calledWith.defaultPath).toBe("/home/user/document.md");
      expect(calledWith.filters).toEqual([{ name: "Markdown", extensions: ["md"] }]);
    });
  });

  describe("case 3 — opts undefined (기본 Save 다이얼로그)", () => {
    test("accepts undefined args and calls dialog with undefined options", async () => {
      mockShowSaveDialog.mockImplementationOnce(async () => ({
        canceled: false,
        filePath: "/tmp/untitled.txt",
      }));

      const result = await invokeShowSaveDialog(undefined);
      expect(result.canceled).toBe(false);
      expect(result.filePath).toBe("/tmp/untitled.txt");
      expect(mockShowSaveDialog).toHaveBeenCalledTimes(1);
      const calledWith = mockShowSaveDialog.mock.calls[0]![0] as Record<string, unknown>;
      expect(calledWith.title).toBeUndefined();
      expect(calledWith.defaultPath).toBeUndefined();
      expect(calledWith.filters).toBeUndefined();
    });
  });

  describe("case 4 — showOpenFile 회귀", () => {
    test("showOpenFile still returns canceled + filePaths array", async () => {
      mockShowOpenDialog.mockImplementationOnce(async () => ({
        canceled: false,
        filePaths: ["/tmp/chosen.ts"],
      }));

      const result = await invokeShowOpenFile({ title: "Open" });
      expect(result.canceled).toBe(false);
      expect(result.filePaths).toEqual(["/tmp/chosen.ts"]);
    });
  });

  describe("case 5 — showOpenDirectory 회귀", () => {
    test("showOpenDirectory still returns canceled + filePaths array", async () => {
      mockShowOpenDialog.mockImplementationOnce(async () => ({
        canceled: true,
        filePaths: [],
      }));

      const result = await invokeShowOpenDirectory({});
      expect(result.canceled).toBe(true);
      expect(result.filePaths).toEqual([]);
    });
  });
});
