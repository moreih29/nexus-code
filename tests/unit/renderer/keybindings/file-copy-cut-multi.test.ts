import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: () => Promise.resolve({ ok: true as const, value: [] }),
  unwrapIpcResult: <T>(r: { ok: boolean; value?: T }): T => r.value as T,
  mustSucceed: <T>(r: { ok: boolean; value?: T }): T => r.value as T,
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

import { useActiveStore } from "../../../../src/renderer/state/stores/active";
import { selectOperablePaths, useFilesStore } from "../../../../src/renderer/state/stores/files";

const WS = "ws-copy-cut-global";
const ROOT = "/repo";

function resetAll(): void {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
  ]);
  useActiveStore.setState({ activeWorkspaceId: WS });
}

beforeEach(() => {
  resetAll();
});

describe("selectOperablePaths — drives fileCopy/fileCut entries", () => {
  it("collapses parent+child via distinctParents when both are in paths", () => {
    useFilesStore.getState().selectAllVisible(WS, [ROOT, `${ROOT}/a.ts`]);
    const paths = selectOperablePaths(useFilesStore.getState(), WS);
    expect(paths).toEqual([ROOT]);
  });
});
