import { expect, test } from "bun:test";
import { type ToastInput, watchToasts } from "../../../../src/renderer/components/ui/toast";
import { copyTextViaIpc } from "../../../../src/renderer/utils/clipboard";
import { ipcErr, ipcOk } from "../../../../src/shared/ipc/result";

test("clipboard IPC confirms success and surfaces a failed write", async () => {
  const originalWindow = globalThis.window;
  const toasts: ToastInput[] = [];
  const unwatch = watchToasts((toast) => toasts.push(toast));
  const replies = [ipcOk({ ok: true }), ipcErr("internal", "private clipboard error")];
  Object.assign(globalThis, { window: { ipc: { call: async () => replies.shift() } } });
  try {
    expect(await copyTextViaIpc("copied")).toBe(true);
    expect(toasts).toHaveLength(0);
    expect(await copyTextViaIpc("failed")).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe("error");
    expect(toasts[0]?.message).not.toContain("private clipboard error");
  } finally {
    unwatch();
    Object.assign(globalThis, { window: originalWindow });
  }
});
