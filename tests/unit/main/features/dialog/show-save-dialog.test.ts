/**
 * dialog IPC 핸들러 단위 테스트.
 *
 * registerDialogChannel() 이 등록한 실제 핸들러를 호출하고, electron.dialog 를
 * mock 으로 교체해 네이티브 다이얼로그에 넘어간 옵션과 반환값을 검증한다.
 *
 * - showSaveDialog: 취소, opts 전달, opts 없음(기본 제목), 잘못된 opts 거부
 * - showOpenFile / showOpenDirectory: 다이얼로그 properties 와 반환값
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must precede the dynamic imports that pull in the mocked modules.
// ---------------------------------------------------------------------------

const mockShowSaveDialog = mock(
  async (_opts: unknown): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: false,
    filePath: "/tmp/output.txt",
  }),
);

const mockShowOpenDialog = mock(
  async (_opts: unknown): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: false,
    filePaths: ["/tmp/input.txt"],
  }),
);

// Only `dialog` is replaced; the rest is the canonical stub from tests/setup.ts.
const realElectron = await import("electron");
mock.module("electron", () => ({
  ...realElectron,
  dialog: {
    showSaveDialog: mockShowSaveDialog,
    showOpenDialog: mockShowOpenDialog,
  },
}));

// Capture the handlers registerDialogChannel() hands to the router. register
// still forwards, so later files that drive the real router are unaffected.
type DialogHandlers = Record<string, (args: unknown) => Promise<unknown>>;
const registered = new Map<string, { call: DialogHandlers }>();

const ipcRouter = await import("../../../../../src/main/infra/ipc-router");
const forwardRegister = ipcRouter.register;
mock.module("../../../../../src/main/infra/ipc-router", () => ({
  ...ipcRouter,
  register: (channelName: string, def: { call: DialogHandlers }) => {
    registered.set(channelName, def);
    forwardRegister(channelName, def as Parameters<typeof forwardRegister>[1]);
  },
}));

const { initMainI18n } = await import("../../../../../src/main/i18n");
const { registerDialogChannel } = await import("../../../../../src/main/features/dialog");

// The handlers read their default titles from the main-process i18n instance.
await initMainI18n("en");
registerDialogChannel();

const handlers = registered.get("dialog")!.call;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockShowSaveDialog.mockClear();
  mockShowOpenDialog.mockClear();
});

describe("dialog.showSaveDialog", () => {
  test("returns canceled with no filePath when the user dismisses the dialog", async () => {
    mockShowSaveDialog.mockImplementationOnce(async () => ({
      canceled: true,
      filePath: undefined,
    }));

    const result = await handlers.showSaveDialog({});

    expect(result).toEqual({ canceled: true, filePath: undefined });
    expect(mockShowSaveDialog).toHaveBeenCalledTimes(1);
  });

  test("passes opts through, asks before overwriting, and returns the chosen path", async () => {
    mockShowSaveDialog.mockImplementationOnce(async () => ({
      canceled: false,
      filePath: "/home/user/document.md",
    }));

    const result = await handlers.showSaveDialog({
      title: "Save Document",
      defaultPath: "/home/user/document.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });

    expect(result).toEqual({ canceled: false, filePath: "/home/user/document.md" });
    expect(mockShowSaveDialog).toHaveBeenCalledWith({
      title: "Save Document",
      defaultPath: "/home/user/document.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
      properties: ["showOverwriteConfirmation"],
    });
  });

  test("uses the localized default title when called without opts", async () => {
    const result = await handlers.showSaveDialog(undefined);

    expect(result).toEqual({ canceled: false, filePath: "/tmp/output.txt" });
    expect(mockShowSaveDialog).toHaveBeenCalledWith({
      title: "Save File",
      defaultPath: undefined,
      filters: undefined,
      properties: ["showOverwriteConfirmation"],
    });
  });

  test("rejects malformed opts without opening the dialog", async () => {
    await expect(handlers.showSaveDialog({ title: 42 })).rejects.toBeInstanceOf(
      ipcRouter.IpcValidationError,
    );
    expect(mockShowSaveDialog).not.toHaveBeenCalled();
  });
});

describe("dialog.showOpenFile", () => {
  test("opens a single-file picker and returns the chosen paths", async () => {
    mockShowOpenDialog.mockImplementationOnce(async () => ({
      canceled: false,
      filePaths: ["/tmp/chosen.ts"],
    }));

    const result = await handlers.showOpenFile({ defaultPath: "/repo" });

    expect(result).toEqual({ canceled: false, filePaths: ["/tmp/chosen.ts"] });
    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      title: "Open File",
      defaultPath: "/repo",
      filters: undefined,
      properties: ["openFile"],
    });
  });
});

describe("dialog.showOpenDirectory", () => {
  test("opens a folder picker that can create folders", async () => {
    mockShowOpenDialog.mockImplementationOnce(async () => ({
      canceled: true,
      filePaths: [],
    }));

    const result = await handlers.showOpenDirectory({});

    expect(result).toEqual({ canceled: true, filePaths: [] });
    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      title: "Select workspace folder",
      defaultPath: undefined,
      properties: ["openDirectory", "createDirectory"],
    });
  });
});
