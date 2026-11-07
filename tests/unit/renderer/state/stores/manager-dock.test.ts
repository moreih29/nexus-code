import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const stored = new Map<string, string>();
const globals = globalThis as Record<string, unknown>;
const before = globals.localStorage;
afterAll(() => {
  globals.localStorage = before;
});
globals.localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: () => Promise.resolve({ ok: true, value: undefined }),
  ipcListen: () => () => {},
}));

const { DOCK_WIDTH_DEFAULT, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, useManagerStore } = await import(
  "../../../../../src/renderer/state/stores/manager"
);

describe("the manager dock's width", () => {
  beforeEach(() => {
    stored.clear();
    useManagerStore.setState({ dockWidth: DOCK_WIDTH_DEFAULT });
  });

  test("a drag moves it within its bounds, kept only once it ends", () => {
    useManagerStore.getState().setDockWidth(520.4, false);
    expect(useManagerStore.getState().dockWidth).toBe(520);
    expect(stored.size).toBe(0);
    useManagerStore.getState().setDockWidth(10_000, true);
    expect(useManagerStore.getState().dockWidth).toBe(DOCK_WIDTH_MAX);
    expect(stored.get("nexus.manager.dockWidth")).toBe(String(DOCK_WIDTH_MAX));
    useManagerStore.getState().setDockWidth(0, true);
    expect(useManagerStore.getState().dockWidth).toBe(DOCK_WIDTH_MIN);
  });
});
