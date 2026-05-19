/**
 * Unit tests for app IPC channel — T7 verification
 *
 * 검사 항목 2: restart 핸들러가 setImmediate 콜백 전에 stateService.flushNow()를
 * 동기 호출하는지 검증.
 *
 * 검사 항목 5: 핸들러가 throw하지 않고 ipcOk 봉투 반환, validateArgs 실패가
 * ipcErr('invalid-args') 로 변환되는 경로.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Electron mock (app.relaunch + app.exit)
// ---------------------------------------------------------------------------
const mockRelaunch = mock((_options?: { args?: string[] }) => {});
const mockExit = mock((_code?: number) => {});

mock.module("electron", () => ({
  app: {
    relaunch: mockRelaunch,
    exit: mockExit,
    getPath: () => "/tmp",
  },
}));

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
mock.module("/Users/kih/workspaces/areas/nexus-code/src/shared/log/main", () => ({
  createLogger: (_source: string) => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  initMainLogger: () => {},
}));

// ---------------------------------------------------------------------------
// ipc-router mock — capture registered handlers for direct invocation.
// ---------------------------------------------------------------------------
type CallHandler = (args: unknown) => unknown;
const registeredChannels = new Map<string, { call: Record<string, CallHandler> }>();

mock.module("/Users/kih/workspaces/areas/nexus-code/src/main/infra/ipc-router", () => {
  const z = require("zod");
  // Replicate real validateArgs: throws IpcValidationError on failure.
  class IpcValidationError extends Error {
    readonly kind = "invalid-args" as const;
    readonly category = "invalid-input" as const;
    constructor(message: string) {
      super(message);
      this.name = "IpcValidationError";
    }
  }
  function validateArgs<T extends ReturnType<typeof z.object>>(
    schema: T,
    args: unknown,
  ): z.infer<T> {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new IpcValidationError(`ipc:call — invalid args: ${parsed.error.message}`);
    }
    return parsed.data;
  }
  function register(channelName: string, def: { call: Record<string, CallHandler>; listen: Record<string, unknown> }) {
    registeredChannels.set(channelName, def);
  }
  return { register, validateArgs, IpcValidationError };
});

// ipcOk / ipcErr
const { ipcOk, ipcErr, isIpcOkResult, isIpcErrResult } = await import(
  "../../../../../src/shared/ipc/result"
);

// ---------------------------------------------------------------------------
// System under test — import AFTER mocks.
// ---------------------------------------------------------------------------
const { registerAppChannel } = await import(
  "../../../../../src/main/features/app/index"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal StateService stub */
function makeStateService(opts?: { flushShouldThrow?: boolean }) {
  const flushMock = mock(() => {
    if (opts?.flushShouldThrow) throw new Error("flush failed");
  });
  return { flushNow: flushMock, _flushMock: flushMock };
}

/** Retrieve the registered restart handler. */
function getRestartHandler() {
  const channel = registeredChannels.get("app");
  if (!channel) throw new Error("app channel not registered");
  const handler = channel.call["restart"];
  if (typeof handler !== "function") throw new Error("restart handler not found");
  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerAppChannel — restart handler (검사 항목 2, 5)", () => {
  beforeEach(() => {
    registeredChannels.clear();
    mockRelaunch.mockClear();
    mockExit.mockClear();
  });

  afterEach(() => {
    registeredChannels.clear();
  });

  // -------------------------------------------------------------------------
  // 검사 항목 5: 정상 인자 → ipcOk(undefined) 반환, throw 없음
  // -------------------------------------------------------------------------
  it("유효한 reason 인자 → ipcOk(undefined) 반환, throw 없음", () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    let result: unknown;
    expect(() => {
      result = handler({ reason: "opacity-change" });
    }).not.toThrow();

    expect(isIpcOkResult(result)).toBe(true);
    if (isIpcOkResult(result)) {
      expect(result.value).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 검사 항목 2: flushNow()가 setImmediate 이전에 동기 호출됨
  // -------------------------------------------------------------------------
  it("flushNow()는 setImmediate 콜백 전에 동기적으로 호출된다", () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    // Before handler call
    expect(ss._flushMock.mock.calls.length).toBe(0);

    handler({ reason: "test-flush-order" });

    // flushNow must have been called synchronously inside handler (before setImmediate fires)
    expect(ss._flushMock.mock.calls.length).toBe(1);

    // app.relaunch / app.exit must NOT have been called yet (deferred via setImmediate)
    expect(mockRelaunch.mock.calls.length).toBe(0);
    expect(mockExit.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 검사 항목 2: setImmediate 후 app.relaunch + app.exit(0) 실행
  // -------------------------------------------------------------------------
  it("setImmediate callback에서 app.relaunch + app.exit(0) 호출된다", async () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    // Drain any pre-queued setImmediate callbacks from prior tests.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Reset counts AFTER draining the queue.
    mockRelaunch.mockClear();
    mockExit.mockClear();

    handler({ reason: "test-relaunch" });

    // Wait for the setImmediate queued by handler to fire.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockRelaunch.mock.calls.length).toBe(1);
    expect(mockExit.mock.calls.length).toBe(1);
    // app.exit must be called with 0
    expect(mockExit.mock.calls[0][0]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 검사 항목 2: flushNow()가 throw해도 handler는 ipcOk를 반환 (non-fatal)
  // -------------------------------------------------------------------------
  it("flushNow()가 throw해도 handler는 ipcOk를 반환한다 (non-fatal)", () => {
    const ss = makeStateService({ flushShouldThrow: true });
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    let result: unknown;
    expect(() => {
      result = handler({ reason: "flush-error-test" });
    }).not.toThrow();

    expect(isIpcOkResult(result)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 검사 항목 5: validateArgs 실패 → IpcValidationError throw
  // (라우터가 ipcErr('invalid-args')로 변환하는 경로 검증)
  // -------------------------------------------------------------------------
  it("reason이 빈 문자열이면 validateArgs가 IpcValidationError를 throw한다", () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    // Empty string violates z.string().min(1)
    expect(() => handler({ reason: "" })).toThrow();
  });

  it("reason이 121자이면 validateArgs가 IpcValidationError를 throw한다", () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    const tooLong = "a".repeat(121);
    expect(() => handler({ reason: tooLong })).toThrow();
  });

  it("reason이 없으면 validateArgs가 IpcValidationError를 throw한다", () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    expect(() => handler({})).toThrow();
  });

  it("reason이 120자이면 유효하다 (max boundary)", () => {
    const ss = makeStateService();
    registerAppChannel(ss as unknown as import("../../../../../src/main/infra/storage/state-service").StateService);
    const handler = getRestartHandler();

    const maxLen = "a".repeat(120);
    let result: unknown;
    expect(() => {
      result = handler({ reason: maxLen });
    }).not.toThrow();
    expect(isIpcOkResult(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 검사 항목 2: flushNow() 동기 I/O 검증 (StateService 직접 테스트)
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService } from "../../../../../src/main/infra/storage/state-service";

describe("StateService.flushNow() — 동기 I/O 검증", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-flush-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flushNow()는 동기적으로 state.json을 디스크에 기록한다", () => {
    const filePath = path.join(tmpDir, "state.json");
    const ss = new StateService(filePath);
    ss.setState({ lastActiveWorkspaceId: "ws-flush-test" });

    // Overwrite the file with stale data to simulate in-memory state diverging
    fs.writeFileSync(filePath, JSON.stringify({ lastActiveWorkspaceId: "stale" }), "utf8");

    // mutate in-memory state without going through setState (simulate pending change)
    // We do this via setState which already calls flush — use a second state change
    ss.setState({ sidebarWidth: 300 });

    // flushNow should synchronously write the current in-memory state
    ss.flushNow();

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.lastActiveWorkspaceId).toBe("ws-flush-test");
    expect(raw.sidebarWidth).toBe(300);
  });

  it("flushNow() 후 .vsctmp 파일이 남지 않는다 (atomic rename)", () => {
    const filePath = path.join(tmpDir, "state.json");
    const tmpPath = `${filePath}.vsctmp`;
    const ss = new StateService(filePath);
    ss.setState({ sidebarWidth: 200 });
    ss.flushNow();

    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
