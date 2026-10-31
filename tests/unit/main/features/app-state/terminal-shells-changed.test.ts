/**
 * appState.set — a change to the default shell or the added shells, even
 * one that clears them, has main send the saved shells to every window.
 */

import { describe, expect, mock, test } from "bun:test";
import type { StateService } from "../../../../../src/main/infra/storage/state-service";
import type { AppState } from "../../../../../src/shared/types/app-state";

const mockHandle = mock((_channel: string, _handler: unknown) => {});

mock.module("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: mockHandle, on: mock(() => {}) },
  webContents: { getAllWebContents: () => [] },
}));

const { setupRouter } = await import("../../../../../src/main/infra/ipc-router");
const { registerAppStateChannel } = await import("../../../../../src/main/features/app-state");

setupRouter();

type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
) => Promise<unknown>;

function setup(): {
  set: (patch: Partial<AppState>) => Promise<unknown>;
  changes: () => number;
  themes: string[];
} {
  let state = {} as AppState;
  const stateService = {
    getState: () => state,
    setState: (patch: Partial<AppState>) => {
      state = { ...state, ...patch };
    },
  } as unknown as StateService;
  let changes = 0;
  const themes: string[] = [];
  registerAppStateChannel(stateService, {
    onTerminalShellsChanged: () => {
      changes += 1;
    },
    onThemeChanged: (theme) => {
      themes.push(theme);
    },
  });
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const handler = calls.filter(([channel]) => channel === "ipc:call").at(-1)?.[1];
  if (!handler) throw new Error("ipc:call was not registered");
  return { set: (patch) => handler({}, "appState", "set", patch), changes: () => changes, themes };
}

const nu = { id: "nu", name: "Nushell", path: "nu", args: [] };

describe("appState.set — shells", () => {
  test("saving the added shells or the default shell reports a change", async () => {
    const { set, changes } = setup();
    await set({ terminalShells: [nu] });
    await set({ terminalShell: { kind: "custom", id: "nu" } });
    expect(changes()).toBe(2);
  });

  test("clearing them reports a change too", async () => {
    const { set, changes } = setup();
    await set({ terminalShell: undefined });
    await set({ terminalShells: undefined });
    expect(changes()).toBe(2);
  });

  test("other settings don't", async () => {
    const { set, changes } = setup();
    await set({ terminalFontSize: 14 });
    expect(changes()).toBe(0);
  });
});

// The window controls Electron draws take the theme from main.
describe("appState.set — theme", () => {
  test("saving the theme reports it", async () => {
    const { set, themes } = setup();
    await set({ terminalFontSize: 14 });
    await set({ themePreference: "github-light" });
    expect(themes).toEqual(["github-light"]);
  });
});
