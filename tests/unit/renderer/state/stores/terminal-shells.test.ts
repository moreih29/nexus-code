/**
 * Shells added in Settings › Terminal — saved to appState as a list, and
 * removing the default one sends the default back to the system default.
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

const { useTerminalStore } = await import("../../../../../src/renderer/state/stores/terminal");

const nu = { id: "nu", name: "Nushell", path: "nu", args: [] };
const psNoLogo = { id: "ps", name: "PS", path: "powershell", args: ["-NoLogo"] };

beforeEach(() => {
  useTerminalStore.getState().hydrate({});
  writes.length = 0;
});

describe("terminal store — added shells", () => {
  it("adds shells in order and saves the list", () => {
    const store = useTerminalStore.getState();
    store.saveCustomShell(nu);
    store.saveCustomShell(psNoLogo);

    expect(useTerminalStore.getState().customShells).toEqual([nu, psNoLogo]);
    expect(writes.at(-1)).toEqual({ terminalShells: [nu, psNoLogo] });
  });

  it("an edit replaces the shell in place", () => {
    useTerminalStore.getState().hydrate({ customShells: [nu, psNoLogo] });
    const renamed = { ...nu, name: "Nu", args: ["-l"] };
    useTerminalStore.getState().saveCustomShell(renamed);

    expect(useTerminalStore.getState().customShells).toEqual([renamed, psNoLogo]);
  });

  it("removing the default shell resets the default", () => {
    useTerminalStore.getState().hydrate({
      customShells: [nu, psNoLogo],
      shell: { kind: "custom", id: "ps" },
    });
    useTerminalStore.getState().removeCustomShell("ps");

    expect(useTerminalStore.getState().customShells).toEqual([nu]);
    expect(useTerminalStore.getState().shell).toBeUndefined();
    expect(writes).toEqual([{ terminalShells: [nu] }, { terminalShell: undefined }]);
  });

  it("adds to the shells another window saved, not to this window's stale copy", () => {
    useTerminalStore.getState().hydrate({ customShells: [] });
    useTerminalStore.getState().hydrateShells({
      shell: { kind: "custom", id: "nu" },
      customShells: [nu],
    });
    useTerminalStore.getState().saveCustomShell(psNoLogo);

    expect(writes).toEqual([{ terminalShells: [nu, psNoLogo] }]);
    expect(useTerminalStore.getState().shell).toEqual({ kind: "custom", id: "nu" });
  });

  it("removing another shell keeps the default, and the last one clears the list", () => {
    const gitBash = { kind: "detected" as const, id: "git-bash" };
    useTerminalStore.getState().hydrate({ customShells: [nu], shell: gitBash });
    useTerminalStore.getState().removeCustomShell("nu");

    expect(useTerminalStore.getState().shell).toEqual(gitBash);
    expect(writes).toEqual([{ terminalShells: undefined }]);
  });
});
