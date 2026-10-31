/**
 * initLspStatusSync — the toast a missing or given-up server calls for comes
 * down once that server runs, however it was started again. The real ipc
 * client and toast modules are spread under spies so later files keep their
 * other exports.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";
import type { LspServerStatus } from "../../../../../src/shared/lsp/status";

const toasts: ToastInput[] = [];
const dismissed: number[] = [];
let emit: (status: LspServerStatus) => void = () => {};

const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  // The toast's id is its place in `toasts`.
  showToast: (input: ToastInput) => toasts.push(input) - 1,
  dismissToast: (id: number) => {
    dismissed.push(id);
  },
}));
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: (_channel: string, event: string, callback: (payload: never) => void) => {
    if (event === "serverStatus") emit = callback;
    return () => {};
  },
  ipcCallResult: () => Promise.resolve({ ok: true, value: [] }),
}));

const { initLspStatusSync } = await import(
  "../../../../../src/renderer/state/operations/lsp-status"
);

const REMOTE = "77777777-7777-4777-8777-777777777777";
const LOCAL = "88888888-8888-4888-8888-888888888888";

const missing = (workspaceId: string): LspServerStatus => ({
  workspaceId,
  languageId: "go",
  state: "failed",
  gaveUp: true,
  missingBinary: "gopls",
  error: "gopls was not found",
});
const running = (workspaceId: string, languageId = "go"): LspServerStatus => ({
  workspaceId,
  languageId,
  state: "running",
});

beforeAll(() => {
  initLspStatusSync();
});

beforeEach(() => {
  toasts.length = 0;
  dismissed.length = 0;
});

describe("initLspStatusSync toasts", () => {
  it("takes down the missing-server toast once the server runs", () => {
    emit(missing(REMOTE));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain("go install golang.org/x/tools/gopls@latest");

    // Another workspace's server running says nothing of this one's.
    emit(running(LOCAL));
    expect(dismissed).toEqual([]);

    emit({ ...running(REMOTE), serverName: "gopls" });
    expect(dismissed).toEqual([0]);
  });

  it("takes down the gave-up toast once the server runs again", () => {
    emit({
      workspaceId: REMOTE,
      languageId: "python",
      state: "failed",
      gaveUp: true,
      error: "crashed",
    });
    emit(running(REMOTE, "python"));

    expect(toasts).toHaveLength(1);
    expect(dismissed).toEqual([0]);
  });
});
