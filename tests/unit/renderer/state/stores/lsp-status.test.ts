import { beforeEach, describe, expect, test } from "bun:test";
import {
  isLspServerBusy,
  lspStatusKey,
  useLspStatusStore,
} from "../../../../../src/renderer/state/stores/lsp-status";

const WS = "ws-1";
const KEY = lspStatusKey(WS, "typescript");

describe("LSP status store", () => {
  beforeEach(() => {
    useLspStatusStore.setState({ statuses: {}, progress: {} });
  });

  test("a server that stops drops the work it left unfinished", () => {
    const store = useLspStatusStore.getState();
    store.setStatus({ workspaceId: WS, languageId: "typescript", state: "running" });
    store.setProgress(WS, "typescript", { title: "Loading" });
    expect(isLspServerBusy(WS, "typescript")).toBe(true);

    store.setStatus({
      workspaceId: WS,
      languageId: "typescript",
      state: "stopped",
      stopReason: "crashed",
    });

    expect(useLspStatusStore.getState().progress[KEY]).toBeUndefined();
    expect(isLspServerBusy(WS, "typescript")).toBe(false);
  });

  test("hydrating keeps a status broadcast while the list was on its way", () => {
    const store = useLspStatusStore.getState();
    store.setStatus({ workspaceId: WS, languageId: "typescript", state: "running" });

    store.hydrate([
      { workspaceId: WS, languageId: "typescript", state: "starting" },
      { workspaceId: WS, languageId: "python", state: "running" },
    ]);

    const { statuses } = useLspStatusStore.getState();
    expect(statuses[KEY]?.state).toBe("running");
    expect(statuses[lspStatusKey(WS, "python")]?.state).toBe("running");
  });

  test("forgets a removed workspace", () => {
    const store = useLspStatusStore.getState();
    store.setStatus({ workspaceId: WS, languageId: "typescript", state: "starting" });
    store.setStatus({ workspaceId: "ws-2", languageId: "typescript", state: "starting" });

    store.forgetWorkspace(WS);

    expect(Object.keys(useLspStatusStore.getState().statuses)).toEqual([
      lspStatusKey("ws-2", "typescript"),
    ]);
  });
});
