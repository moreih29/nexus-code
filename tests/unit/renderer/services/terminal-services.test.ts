import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TerminalControllerDeps } from "../../../../src/renderer/services/terminal/controller";
import type {
  PtyClientOptions,
  TerminalDimensions,
} from "../../../../src/renderer/services/terminal/types";

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
  // matchMedia stub: theme.ts calls window.matchMedia at module-init time.
  // Without this, any test file that loads theme.ts after this file replaces
  // globalThis.window would crash with "window.matchMedia is not a function".
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

// document stub: the terminal controller's resolveCurrentThemeId() accesses
// document.documentElement.getAttribute("data-theme") at init time. In bun's
// test environment, `document` is undefined when window is replaced with a
// plain stub. Providing a minimal document stub lets initialize() proceed so
// this.term and this.ptyClient are set before tests call reopen().
(globalThis as Record<string, unknown>).document = {
  documentElement: {
    getAttribute: (_name: string): string | null => null,
    addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject): void => {},
    removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject): void => {},
    setAttribute: (_name: string, _value: string): void => {},
  },
  fonts: { load: () => Promise.resolve([]) },
};

// foregroundProcess RPC가 반환할 mock 응답 — 테스트별로 setForegroundProcessName으로 변경.
let mockForegroundProcessName = "lazygit";

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock((channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "pty" && method === "spawn")
      return Promise.resolve({ ok: true as const, value: { pid: 1234 } });
    if (channel === "pty" && method === "foregroundProcess")
      return Promise.resolve({ ok: true as const, value: { name: mockForegroundProcessName } });
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
  // The exports below are unused by terminal-services tests but must be present
  // in the mock so that any module with a static `import { … }` binding for
  // ipc/client can link successfully when evaluated in the same Bun process.
  // Bun's module cache freezes the export-list of the first mock registered for
  // a given path; any subsequent mock.module call cannot add new named exports
  // that were absent from the original registration.
  ipcStream: mock(() => ({ promise: new Promise(() => {}), onProgress: () => () => {} })),
  canUseIpcBridge: mock(() => false),
  // unwrapIpcResult / mustSucceed — used by fs-mutations which is transitively
  // loaded through operations/files.ts → open-terminal.ts.
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
  isIpcResult: (v: unknown): boolean => v !== null && typeof v === "object" && "ok" in (v as object),
  isIpcOkResult: (v: unknown): boolean => v !== null && typeof v === "object" && (v as Record<string, unknown>)["ok"] === true,
  isIpcErrResult: (v: unknown): boolean => v !== null && typeof v === "object" && (v as Record<string, unknown>)["ok"] === false,
}));

const { closeTerminal, createTerminalController, openTerminal } = await import(
  "../../../../src/renderer/services/terminal"
);
const { TERMINAL_REOPENED_SEPARATOR, isShellPromptLikeTitle } = await import(
  "../../../../src/renderer/services/terminal/controller"
);
const { createPtyClient } = await import("../../../../src/renderer/services/terminal/pty-client");
const { closeGroup } = await import("../../../../src/renderer/state/operations");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout");
const { findLeaf } = await import("../../../../src/renderer/state/stores/layout/helpers");
const { useTabsStore } = await import("../../../../src/renderer/state/stores/tabs");

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

function tabsFor(workspaceId: string) {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
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
  const spawnCalls: TerminalDimensions[] = [];
  const ptyWrites: string[] = [];
  let ptyOptions: PtyClientOptions | null = null;
  // 가변 buffer state — 테스트에서 setBufferType("alternate" | "normal")로 전환해
  // alternate screen 가드 동작을 검증한다. 기본값은 "alternate"로 두어 기존 OSC
  // title sync 테스트들이 별도 setup 없이 통과하도록 한다(TUI 시나리오 가정).
  const bufferState: { active: { type: "normal" | "alternate" } } = {
    active: { type: "alternate" },
  };
  // controller.ts:317에서 attachCustomKeyEventHandler를 호출해 keydown 가로채기
  // 핸들러를 등록한다. 테스트에서 합성 KeyboardEvent로 호출해 분기를 검증하기
  // 위해 핸들러를 capture한다.
  let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  // onTitleChange callback도 동일하게 capture — OSC 0/1/2 시나리오 검증용.
  let capturedTitleHandler: ((title: string) => void) | null = null;
  // alt screen exit CSI handler. params로 47/1047/1049 중 하나가 들어오면 alt→normal
  // 전이로 해석되어 processTitle clear가 발사된다. xterm.js v5 API의 params는
  // (number | number[])[] 직접 배열 형태.
  let capturedAltExitHandler:
    | ((params: ReadonlyArray<number | number[]>) => boolean)
    | null = null;
  // alt screen ENTER CSI handler — TUI 시작 시 fg process 이름 IPC로 가져와 processTitle.
  let capturedAltEnterHandler:
    | ((params: ReadonlyArray<number | number[]>) => boolean)
    | null = null;
  const deps: TerminalControllerDeps = {
    waitForTerminalFonts: () => Promise.resolve(),
    createTerminal: () => ({
      element: undefined,
      rows: 24,
      parser: {
        registerOscHandler: () => ({ dispose: () => {} }),
        registerCsiHandler: (
          id: { prefix?: string; intermediates?: string; final: string },
          cb: (params: ReadonlyArray<number | number[]>) => boolean,
        ) => {
          // controller가 prefix:"?", final:"l"(exit) / final:"h"(enter) 두 핸들러 등록.
          if (id.prefix === "?" && id.final === "l") {
            capturedAltExitHandler = cb;
          } else if (id.prefix === "?" && id.final === "h") {
            capturedAltEnterHandler = cb;
          }
          return { dispose: () => {} };
        },
      },
      buffer: bufferState,
      dispose: () => {},
      loadAddon: () => {},
      onData: () => ({ dispose: () => {} }),
      onSelectionChange: () => ({ dispose: () => {} }),
      onTitleChange: (handler) => {
        capturedTitleHandler = handler;
        return { dispose: () => {} };
      },
      getSelection: () => "",
      open: () => {},
      refresh: () => {},
      write: (data) => {
        writes.push(data);
      },
      attachCustomKeyEventHandler: (handler) => {
        capturedKeyHandler = handler;
      },
    }),
    createFitAddon: () => ({
      dispose: () => {},
      fit: () => {},
      proposeDimensions: () => ({ cols: 100, rows: 40 }),
    }),
    createLigaturesAddon: () => ({ dispose: () => {} }) as never,
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
    getPtyOptions: () => ptyOptions,
    getKeyHandler: () => capturedKeyHandler,
    getTitleHandler: () => capturedTitleHandler,
    getAltExitHandler: () => capturedAltExitHandler,
    getAltEnterHandler: () => capturedAltEnterHandler,
    setBufferType(type: "normal" | "alternate"): void {
      bufferState.active.type = type;
    },
  };
}

describe("services/terminal open and close", () => {
  beforeEach(() => {
    resetStores();
    resetIpc();
  });

  it("openTerminal always creates a new terminal tab", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const second = openTerminal({ workspaceId: WS, cwd: "/workspace" });

    expect(first.tabId).not.toBe(second.tabId);
    expect(first.groupId).toBe(second.groupId);
    expect(tabsFor(WS)).toHaveLength(2);
  });

  it("openTerminal routes to an explicit groupId", () => {
    openTerminal({ workspaceId: WS, cwd: "/left" });
    const layout = useLayoutStore.getState().byWorkspace[WS];
    if (!layout) throw new Error("layout missing");
    const leftGroupId = layout.activeGroupId;
    const rightGroupId = useLayoutStore
      .getState()
      .splitGroup(WS, leftGroupId, "horizontal", "after");

    const terminal = openTerminal({ workspaceId: WS, cwd: "/right" }, { groupId: rightGroupId });

    const nextLayout = useLayoutStore.getState().byWorkspace[WS];
    if (!nextLayout) throw new Error("layout missing");
    const rightLeaf = findLeaf(nextLayout.root, rightGroupId);

    expect(terminal.groupId).toBe(rightGroupId);
    expect(rightLeaf?.tabIds).toContain(terminal.tabId);
    expect(nextLayout.activeGroupId).toBe(rightGroupId);
  });

  it("openTerminal supports newSplit", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const second = openTerminal(
      { workspaceId: WS, cwd: "/workspace" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    const layout = useLayoutStore.getState().byWorkspace[WS];
    expect(layout?.root.kind).toBe("split");
    expect(second.groupId).not.toBe(first.groupId);
    expect(second.tabId).not.toBe(first.tabId);
    expect(tabsFor(WS)).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// PTY exit lifecycle — verifies the renderer-side cleanup that happens AFTER
// the main process emits 'pty:exit'. The previous tests only assert that the
// renderer sent 'pty:kill'; this section closes the loop by simulating the
// exit echo and asserting that onExit fires, listeners stop firing, and a
// subsequent spawn for the same tabId is not deduped against the dead session.
// ---------------------------------------------------------------------------

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

    // Late-arriving data after exit should still flow through onData (the listener
    // is removed by dispose, not by exit) — but a subsequent dispose must not double-fire onExit.
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

    // Exit echo from main process — should clear the live-session marker.
    emit("pty", "exit", { workspaceId: WS, tabId: "tab-respawn", code: 0 });

    // Next spawn must hit the IPC again (not be deduped as already-live).
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

describe("services/terminal controller reopen", () => {
  beforeEach(resetIpc);

  it("reopens with the same tab identity and original cwd without clearing scrollback", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    await controller.reopen();

    expect(harness.getPtyOptions()).toMatchObject({
      workspaceId: WS,
      tabId: "tab-reopen",
      cwd: "/workspace/original",
    });
    expect(harness.spawnCalls).toEqual([{ cols: 100, rows: 40 }]);
    expect(harness.writes).toEqual([`\r\n${TERMINAL_REOPENED_SEPARATOR}\r\n`]);

    controller.dispose();
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
    // spawn returning null signals the session is already live; the controller
    // must not throw so the caller never sets reopenState to "failed".
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

    // Must resolve without throwing — no failed state propagated to the view.
    await expect(controller.reopen()).resolves.toBeUndefined();
    // No separator written when the session was already live.
    expect(harness.writes).toEqual([]);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Custom key handler — line-begin/line-end → Ctrl+A/Ctrl+E 치환.
//
// 배경: Claude Code TUI(Ink)가 `\x1b[H`/`\x1b[F`를 line-begin/end로 인식하지
//   않고, 우리 환경의 xterm.js도 Home/End를 PTY로 보내지 않는 합산 이슈로 인해
//   라인 단축키가 무반응이었다. cmux 실측에서 `^A`/`^E`로 치환해 보냄을 확인.
//   readline 표준이라 Claude Code / bash / zsh 모두 호환.
//
// macOS 컨벤션 양쪽 모두 매핑:
//   - 외장 풀사이즈 키보드: 단독 Home / End
//   - 내장 키보드(Home/End 키 없음): Cmd+← / Cmd+→
// ---------------------------------------------------------------------------
describe("services/terminal controller — 라인 단축키 치환", () => {
  beforeEach(() => {
    resetStores();
    resetIpc();
  });

  async function setupHandler() {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-keymap",
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

  // 이 파일은 globalThis.window를 plain stub으로 덮어써 happy-dom의 KeyboardEvent
  // 가 사용 불가능하다. 핸들러가 참조하는 필드만 갖는 fake로 충분.
  interface FakeKeyEvent {
    type: string;
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
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
  }): FakeKeyEvent {
    const event: FakeKeyEvent = {
      type: opts.type ?? "keydown",
      key: opts.key,
      shiftKey: opts.shiftKey,
      metaKey: opts.metaKey,
      ctrlKey: opts.ctrlKey,
      altKey: opts.altKey,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    return event;
  }

  it("Home 단독 keydown → \\x01 송신 + 기본 동작 차단", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "Home" });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.ptyWrites).toEqual(["\x01"]);

    controller.dispose();
  });

  it("End 단독 keydown → \\x05 송신 + 기본 동작 차단", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "End" });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.ptyWrites).toEqual(["\x05"]);

    controller.dispose();
  });

  it("Cmd+ArrowLeft (macOS 내장 키보드 line-begin) → \\x01 송신", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "ArrowLeft", metaKey: true });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.ptyWrites).toEqual(["\x01"]);

    controller.dispose();
  });

  it("Cmd+ArrowRight (macOS 내장 키보드 line-end) → \\x05 송신", async () => {
    const { harness, controller, handler } = await setupHandler();
    const event = fakeKeyEvent({ key: "ArrowRight", metaKey: true });

    const result = handler(event as unknown as KeyboardEvent);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.ptyWrites).toEqual(["\x05"]);

    controller.dispose();
  });

  it("modifier 동반 Home/End / 추가 modifier 동반 Cmd+arrow는 통과", async () => {
    const { harness, controller, handler } = await setupHandler();

    // Shift+Home: selection 확장 — 통과
    expect(
      handler(fakeKeyEvent({ key: "Home", shiftKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    // Cmd+End (Home/End 키와 modifier 조합): 통과 — 정의되지 않은 시퀀스라 보존
    expect(
      handler(fakeKeyEvent({ key: "End", metaKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    // Ctrl+Home: buffer-top 의도: 통과
    expect(
      handler(fakeKeyEvent({ key: "Home", ctrlKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    // Alt+End: word-level 의도: 통과
    expect(
      handler(fakeKeyEvent({ key: "End", altKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    // Shift+Cmd+ArrowLeft: macOS selection 확장 의도: 통과
    expect(
      handler(
        fakeKeyEvent({ key: "ArrowLeft", metaKey: true, shiftKey: true }) as unknown as KeyboardEvent,
      ),
    ).toBe(true);
    // Option+ArrowRight: word-jump 의도: 통과 (meta 없이 alt 단독)
    expect(
      handler(fakeKeyEvent({ key: "ArrowRight", altKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    // 단독 ArrowLeft/ArrowRight (modifier 없음): cursor 이동 — 통과
    expect(
      handler(fakeKeyEvent({ key: "ArrowLeft" }) as unknown as KeyboardEvent),
    ).toBe(true);
    expect(
      handler(fakeKeyEvent({ key: "ArrowRight" }) as unknown as KeyboardEvent),
    ).toBe(true);

    expect(harness.ptyWrites).toEqual([]);

    controller.dispose();
  });

  it("keyup은 통과 — keydown만 인터셉트", async () => {
    const { harness, controller, handler } = await setupHandler();

    expect(
      handler(fakeKeyEvent({ type: "keyup", key: "Home" }) as unknown as KeyboardEvent),
    ).toBe(true);
    expect(harness.ptyWrites).toEqual([]);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// isShellPromptLikeTitle — shell prompt OSC 필터 휴리스틱
// ---------------------------------------------------------------------------
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

  it("@만 있고 : 없음 → 통과 (이메일 등 비-prompt 가능)", () => {
    expect(isShellPromptLikeTitle("@anthropic")).toBe(false);
  });

  it("빈 문자열 → 통과 (store가 clear로 해석)", () => {
    expect(isShellPromptLikeTitle("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OSC 0/1/2 title sync — claude / lazygit / lazydocker가 자신의 이름/상태를
// 보내면 탭의 processTitle이 갱신되어야 한다.
// ---------------------------------------------------------------------------
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

  it("OSC title 수신 → tab.processTitle 갱신 + display title 변경", async () => {
    const { controller, tab, titleHandler } = await setupWithTab();

    titleHandler("lazygit");

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBe("lazygit");
    expect(updated.title).toBe("lazygit");

    controller.dispose();
  });

  it("customTitle 있을 때 OSC title은 processTitle만 갱신 — display는 보존", async () => {
    const { controller, tab, titleHandler } = await setupWithTab();
    useTabsStore.getState().renameTab(WS, tab.id, "Pinned");

    titleHandler("lazygit");

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.customTitle).toBe("Pinned");
    expect(updated.processTitle).toBe("lazygit");
    expect(updated.title).toBe("Pinned");

    controller.dispose();
  });

  it("빈 OSC title은 processTitle clear → defaultTitle로 복귀", async () => {
    const { controller, tab, titleHandler } = await setupWithTab();
    titleHandler("lazygit");
    titleHandler("");

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
  });

  it("normal screen에서 발사된 title은 무시 — ls/grep 같은 단발 명령 가드", async () => {
    // 새 harness — buffer 기본 alternate를 normal로 전환해 단발 명령 시나리오 재현.
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

    // zsh preexec hook이 현재 명령을 OSC 2로 발사하는 케이스 — buffer는 여전히 normal.
    titleHandler("ls -G");

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("Terminal");

    controller.dispose();
  });

  it("alternate ↔ normal 전이를 거치는 시나리오 — TUI title만 적용 + 종료 시 자동 복귀", async () => {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    const harness = makeTerminalControllerDeps();
    harness.setBufferType("normal"); // 처음 shell은 normal screen
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

    // shell preexec — 무시되어야 함
    titleHandler("ls -G");
    expect(useTabsStore.getState().byWorkspace[WS][tab.id].processTitle).toBeUndefined();

    // 사용자가 lazygit 실행 → alternate 진입 → "lazygit" 발사
    harness.setBufferType("alternate");
    titleHandler("lazygit");
    expect(useTabsStore.getState().byWorkspace[WS][tab.id].title).toBe("lazygit");

    // lazygit 종료 → alt screen exit CSI 발사(`\x1b[?1049l`) → processTitle clear → defaultTitle 복귀
    harness.setBufferType("normal");
    const ret = altExitHandler([1049]);
    expect(ret).toBe(false); // xterm.js 기본 buffer swap에 위임
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
    // 25 = DECTCEM(cursor hide), 우리 alt 가드 대상이 아님
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

    // alt-screen ENTER — fire-and-forget RPC 호출 후 즉시 false 반환
    const ret = altEnter([1049]);
    expect(ret).toBe(false);

    // 비동기 IPC 응답 처리 대기
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
    mockForegroundProcessName = ""; // fallback
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
    mockForegroundProcessName = "lazygit"; // restore default
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

    altEnter([25]); // DECTCEM cursor show — 우리 대상 아님
    await Promise.resolve();
    await Promise.resolve();

    expect(
      ipcCalls.some((c) => c.channel === "pty" && c.method === "foregroundProcess"),
    ).toBe(false);

    controller.dispose();
  });

  it("customTitle은 alt-exit에도 보존된다 — processTitle만 clear", async () => {
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    useTabsStore.getState().renameTab(WS, tab.id, "내 작업창");
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
    altExit([1049]);

    const updated = useTabsStore.getState().byWorkspace[WS][tab.id];
    expect(updated.customTitle).toBe("내 작업창");
    expect(updated.processTitle).toBeUndefined();
    expect(updated.title).toBe("내 작업창");

    controller.dispose();
  });
});
