/**
 * Window opacity and inactive-panel dim — a slider drag previews each step
 * without persisting it; only the committed value reaches appState.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const writes: unknown[] = [];

const CLIENT = "../../../../../src/renderer/ipc/client";

// Other files mock the IPC client process-wide, so this file installs its
// own and puts back whatever it found when it is done.
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (_channel: string, _method: string, args: unknown) => {
    writes.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { useWindowOpacityStore } = await import(
  "../../../../../src/renderer/state/stores/window-opacity"
);
const { useInactivePanelDimStore } = await import(
  "../../../../../src/renderer/state/stores/inactive-panel-dim"
);

beforeEach(() => {
  writes.length = 0;
});

describe("appearance sliders", () => {
  it("previews opacity steps and persists only the committed value", () => {
    const store = useWindowOpacityStore.getState();
    store.setOpacity(0.9, { persist: false });
    store.setOpacity(0.8, { persist: false });
    expect(useWindowOpacityStore.getState().opacity).toBe(0.8);
    expect(writes).toEqual([]);

    store.setOpacity(0.8);
    expect(writes).toEqual([{ windowOpacity: 0.8 }]);
  });

  it("previews dim steps and persists only the committed value", () => {
    const store = useInactivePanelDimStore.getState();
    store.setDim(1.2, { persist: false });
    expect(useInactivePanelDimStore.getState().dim).toBe(1.2);
    expect(writes).toEqual([]);

    store.setDim(1.2);
    expect(writes).toEqual([{ inactivePanelDim: 1.2 }]);
  });
});
