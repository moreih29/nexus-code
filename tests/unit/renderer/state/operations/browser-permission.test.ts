import { afterAll, expect, it, mock } from "bun:test";

const listeners = new Map<string, (payload: unknown) => void>();
const CLIENT = "../../../../../src/renderer/ipc/client";
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcListen: (channel: string, event: string, handler: (payload: unknown) => void) => {
    listeners.set(`${channel}.${event}`, handler);
    return () => listeners.delete(`${channel}.${event}`);
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { initBrowserPermissionSubscriptions } = await import(
  "../../../../../src/renderer/state/operations/browser-permission"
);
const { useBrowserPermissionsStore } = await import(
  "../../../../../src/renderer/state/stores/browser-permissions"
);

it("a decision remembered or forgotten in main tells an open Settings page to reload", () => {
  initBrowserPermissionSubscriptions();
  const before = useBrowserPermissionsStore.getState().rememberedRevision;
  listeners.get("browserPermission.rememberedChanged")?.({ workspaceId: "ws" });
  expect(useBrowserPermissionsStore.getState().rememberedRevision).toBe(before + 1);
});
