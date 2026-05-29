/**
 * Unit tests for `useBrowserPermissionsStore`.
 *
 * Covers:
 *   1. hydrate() — initializes grants from persisted AppState value.
 *   2. hydrate() — treats undefined (absent field) as empty record.
 *   3. setGrant() — sets a single-key permission group to enabled.
 *   4. setGrant() — sets a multi-key permission group (e.g. midi+midiSysex) atomically.
 *   5. setGrant() — disabling a permission updates the record.
 *   6. setGrant() — calls ipcCallResult with the full merged record.
 *   7. setGrant() — does not clobber unrelated keys already in the record.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock ipcCallResult so tests run without a real Electron IPC bridge.
// ---------------------------------------------------------------------------

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];

const realIpcClient = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(async (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return { ok: true as const, value: undefined };
  }),
}));

// Import after mock so the store binds to the mocked ipcCallResult.
const { useBrowserPermissionsStore } = await import(
  "../../../../../src/renderer/state/stores/browser-permissions"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useBrowserPermissionsStore.setState({ grants: {} });
  ipcCalls.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useBrowserPermissionsStore.hydrate()", () => {
  beforeEach(resetStore);

  test("initializes grants from persisted AppState value", () => {
    useBrowserPermissionsStore.getState().hydrate({ geolocation: true, media: false });
    const { grants } = useBrowserPermissionsStore.getState();
    expect(grants["geolocation"]).toBe(true);
    expect(grants["media"]).toBe(false);
  });

  test("treats undefined (absent field) as empty record", () => {
    useBrowserPermissionsStore.getState().hydrate(undefined);
    const { grants } = useBrowserPermissionsStore.getState();
    expect(Object.keys(grants)).toHaveLength(0);
  });

  test("overwrites previous state on second hydrate", () => {
    useBrowserPermissionsStore.getState().hydrate({ geolocation: true });
    useBrowserPermissionsStore.getState().hydrate({ media: true });
    const { grants } = useBrowserPermissionsStore.getState();
    expect(grants["geolocation"]).toBeUndefined();
    expect(grants["media"]).toBe(true);
  });
});

describe("useBrowserPermissionsStore.setGrant()", () => {
  beforeEach(resetStore);

  test("sets a single-key permission group to enabled", () => {
    useBrowserPermissionsStore.getState().setGrant(["geolocation"], true);
    const { grants } = useBrowserPermissionsStore.getState();
    expect(grants["geolocation"]).toBe(true);
  });

  test("sets a multi-key permission group (midi+midiSysex) atomically", () => {
    useBrowserPermissionsStore.getState().setGrant(["midi", "midiSysex"], true);
    const { grants } = useBrowserPermissionsStore.getState();
    expect(grants["midi"]).toBe(true);
    expect(grants["midiSysex"]).toBe(true);
  });

  test("disabling a permission updates the record", () => {
    // First enable, then disable.
    useBrowserPermissionsStore.getState().setGrant(["geolocation"], true);
    useBrowserPermissionsStore.getState().setGrant(["geolocation"], false);
    const { grants } = useBrowserPermissionsStore.getState();
    expect(grants["geolocation"]).toBe(false);
  });

  test("calls ipcCallResult appState.set with the full merged record", async () => {
    // Seed some existing state first.
    useBrowserPermissionsStore.getState().hydrate({ media: true });
    ipcCalls.length = 0; // hydrate doesn't call IPC, but clear just in case

    useBrowserPermissionsStore.getState().setGrant(["geolocation"], true);

    // Allow the async IPC call to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ipcCalls).toHaveLength(1);
    const call = ipcCalls[0];
    expect(call?.channel).toBe("appState");
    expect(call?.method).toBe("set");
    expect((call?.args as Record<string, unknown>)["browserPermissionGrants"]).toEqual({
      media: true,
      geolocation: true,
    });
  });

  test("does not clobber unrelated keys already in the record", () => {
    useBrowserPermissionsStore.getState().hydrate({ media: true, notifications: false });
    useBrowserPermissionsStore.getState().setGrant(["geolocation"], true);
    const { grants } = useBrowserPermissionsStore.getState();
    expect(grants["media"]).toBe(true);
    expect(grants["notifications"]).toBe(false);
    expect(grants["geolocation"]).toBe(true);
  });
});
