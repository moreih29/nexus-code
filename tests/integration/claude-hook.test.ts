/**
 * Integration: Claude hook 파이프라인 round-trip 테스트.
 *
 * 실제 claude 바이너리나 node-pty 없이 hook 파이프라인을 검증한다.
 * ClaudeStatusBroker + registerHookHandler를 직접 조립해 각 시나리오를 구동한다.
 *
 * 시나리오:
 *   1. hook round-trip — 5종 subcommand 처리 후 broker 상태 전이 + broadcast 검증
 *   2. 알림 중복 방지 — hook notification은 OS 알림 1회, OSC 입력 시 osc-notification
 *      dispatcher도 독립 동작하는지(채널 분리 검증)
 *   3. PTY exit cleanup — exit 이벤트 후 broker entry 제거
 *   4. PermissionRequest passthrough — broker permissionPending + respondHook 즉시 호출
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Electron 모킹 — 모든 import 이전에 등록해야 한다.
// ---------------------------------------------------------------------------

// electron-log/main 모킹 — ipc-router가 모듈 로드 시 로거를 초기화하므로 사전 stub.
mock.module("electron-log/main", () => ({
  default: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    initialize: () => {},
    transports: {
      file: { resolvePathFn: undefined, level: "debug", format: undefined },
      console: { level: "info", format: undefined },
    },
  },
}));

mock.module("electron", () => ({
  ipcMain: {
    handle: mock(() => {}),
    on: mock(() => {}),
  },
  webContents: {
    getAllWebContents: mock(() => []),
  },
  app: { getPath: () => "/tmp" },
  BrowserWindow: {
    getFocusedWindow: mock(() => null),
    getAllWindows: mock(() => []),
  },
}));

// ---------------------------------------------------------------------------
// 테스트 대상 모듈 import
// ---------------------------------------------------------------------------

import { ClaudeStatusBroker } from "../../src/main/features/claude/status";
import { ActiveContextStore } from "../../src/main/features/claude/active-context";
import { registerHookHandler } from "../../src/main/features/claude/hook-handler";
import { OscNotificationDispatcher } from "../../src/main/features/pty/osc-notification";
import type { HookHandlerDeps } from "../../src/main/features/claude/hook-handler";
import type { AgentChannel } from "../../src/main/infra/agent/channel";

// ---------------------------------------------------------------------------
// 테스트 헬퍼 타입 및 팩토리
// ---------------------------------------------------------------------------

/** agentHost 이벤트 에미터 가짜 구현 */
class FakeAgentHost {
  private readonly listeners = new Map<string, Array<(args: unknown) => void>>();

  on(event: string, cb: (args: unknown) => void): () => void {
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    list.push(cb);
    return () => {
      const l = this.listeners.get(event);
      if (l) {
        const idx = l.indexOf(cb);
        if (idx !== -1) l.splice(idx, 1);
      }
    };
  }

  emit(event: string, args: unknown): void {
    const list = this.listeners.get(event) ?? [];
    for (const cb of list) {
      cb(args);
    }
  }
}

/** AgentChannel 가짜 구현 — claude.respondHook 호출을 기록한다 */
class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    return undefined as TResult;
  }

  fire(_method: string, _params?: unknown): void {}
  on(_event: string, _cb: (payload: unknown) => void): () => void { return () => {}; }
  onLifecycle(_cb: (event: unknown) => void): () => void { return () => {}; }
  dispose(): void {}
}

/** HookHandlerDeps 기본 팩토리 */
function makeDeps(overrides?: Partial<HookHandlerDeps>): {
  deps: HookHandlerDeps;
  broker: ClaudeStatusBroker;
  agentHost: FakeAgentHost;
  channel: FakeAgentChannel;
  broadcastCalls: Array<{ channel: string; event: string; args: unknown }>;
  notificationCtor: ReturnType<typeof mock>;
  notificationInstances: Array<{ title: string; body: string; showCalled: boolean; clickHandlers: Array<() => void> }>;
} {
  // broadcast 호출 기록용 배열
  const broadcastCalls: Array<{ channel: string; event: string; args: unknown }> = [];
  const broadcastFn = mock((ch: string, ev: string, args: unknown) => {
    broadcastCalls.push({ channel: ch, event: ev, args });
  });

  // OS 알림 인스턴스 기록용
  const notificationInstances: Array<{ title: string; body: string; showCalled: boolean; clickHandlers: Array<() => void> }> = [];

  // Electron Notification 생성자 모킹
  const notificationCtor = mock(function(this: unknown, opts: { title: string; body: string }) {
    const instance = {
      title: opts.title,
      body: opts.body,
      showCalled: false,
      clickHandlers: [] as Array<() => void>,
    };
    notificationInstances.push(instance);
    // 메서드를 반환 객체에 바인딩 (생성자 패턴)
    return {
      on(event: string, handler: () => void) {
        if (event === "click") {
          instance.clickHandlers.push(handler);
        }
      },
      show() {
        instance.showCalled = true;
      },
    };
  }) as unknown as typeof import("electron").Notification;

  const broker = new ClaudeStatusBroker(broadcastFn);
  const activeContext = new ActiveContextStore();
  const agentHost = new FakeAgentHost();
  const channel = new FakeAgentChannel();

  const deps: HookHandlerDeps = {
    broker,
    activeContext,
    agentHost,
    channelProvider: {
      tryGetAgentChannel: async (_id: string) => channel,
    },
    workspaceManager: {
      getName: (_id: string) => "TestWorkspace",
    },
    getFocusedWindow: () => null, // 앱이 포커스 상태가 아님 — OS 알림 발사
    electronNotificationCtor: notificationCtor,
    broadcastFn,
    ...overrides,
  };

  return { deps, broker, activeContext, agentHost, channel, broadcastCalls, notificationCtor, notificationInstances };
}

/** hook 이벤트 payload를 만드는 헬퍼 */
function makeHookPayload(
  subcommand: string,
  extra: Record<string, unknown> = {},
  workspaceId = "ws-1",
  tabId = "tab-1",
) {
  return {
    hookId: `hook-${subcommand}-001`,
    workspaceId,
    tabId,
    subcommand,
    payload: extra,
  };
}

// ---------------------------------------------------------------------------
// 시나리오 1: hook round-trip — 5종 subcommand 처리 검증
// ---------------------------------------------------------------------------

describe("시나리오 1: hook round-trip — 5종 subcommand", () => {
  let ctx: ReturnType<typeof makeDeps>;
  let teardown: () => void;

  beforeEach(() => {
    ctx = makeDeps();
    teardown = registerHookHandler(ctx.deps);
  });

  afterEach(() => {
    teardown();
  });

  it("session-start → broker.set(running) + broadcast 발사", async () => {
    // given: session-start 이벤트 emit
    ctx.agentHost.emit("claude.hook", makeHookPayload("session-start"));
    // 비동기 처리 완료 대기
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: broker 상태가 running이어야 한다
    const entry = ctx.broker.get("ws-1", "tab-1");
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe("running");

    // then: broadcast("claude", "status", ...) 가 발사되었어야 한다
    const statusBroadcasts = ctx.broadcastCalls.filter(
      (c) => c.channel === "claude" && c.event === "status",
    );
    expect(statusBroadcasts.length).toBeGreaterThanOrEqual(1);
    const last = statusBroadcasts.at(-1)!.args as Record<string, unknown>;
    expect(last.workspaceId).toBe("ws-1");
    expect(last.tabId).toBe("tab-1");
    expect(last.status).toBe("running");
  });

  it("user-prompt-submit → broker.set(running)", async () => {
    // given: 사전에 needsInput 상태로 설정
    ctx.broker.set("ws-1", "tab-1", "needsInput", "기다리는 중");
    ctx.broadcastCalls.length = 0; // 기존 broadcast 기록 초기화

    ctx.agentHost.emit("claude.hook", makeHookPayload("user-prompt-submit"));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: running 전환 — attention indicator 해제는 broker.set의
    // status 변경이 처리한다 (notificationClick broadcast는 yank back 버그라 제거됨).
    expect(ctx.broker.get("ws-1", "tab-1")?.status).toBe("running");
    const clickBroadcasts = ctx.broadcastCalls.filter(
      (c) => c.channel === "pty" && c.event === "notificationClick",
    );
    expect(clickBroadcasts).toHaveLength(0);
  });

  it("notification → broker.set(needsInput, message) + OS 알림 발사", async () => {
    ctx.agentHost.emit(
      "claude.hook",
      makeHookPayload("notification", { message: "확인 필요" }),
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: needsInput 상태 + message 포함
    const entry = ctx.broker.get("ws-1", "tab-1");
    expect(entry?.status).toBe("needsInput");
    expect(entry?.message).toBe("확인 필요");

    // then: OS 알림이 1회 발사되어야 한다 (앱 비포커스 상태)
    expect(ctx.notificationInstances).toHaveLength(1);
    expect(ctx.notificationInstances[0].showCalled).toBe(true);
  });

  it("stop (앱 비포커스) → broker.set(completed) + OS 알림 발사", async () => {
    // given: running 상태에서 stop. 기본 ctx는 getFocusedWindow=null(비포커스).
    ctx.broker.set("ws-1", "tab-1", "running");
    ctx.broadcastCalls.length = 0;

    ctx.agentHost.emit("claude.hook", makeHookPayload("stop"));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: completed 전환 (사용자 확인 필요)
    expect(ctx.broker.get("ws-1", "tab-1")?.status).toBe("completed");

    // then: OS 알림 발사
    expect(ctx.notificationInstances.length).toBeGreaterThanOrEqual(1);
    expect(ctx.notificationInstances.at(-1)?.body).toBe("Response complete");
  });

  it("stop (사용자가 그 탭을 보는 중) → broker.set(idle) + 알림 미발사", async () => {
    // given: 포커스 + active context 일치
    ctx = makeDeps({
      getFocusedWindow: () =>
        ({ isMinimized: () => false } as unknown as import("electron").BrowserWindow),
    });
    teardown = registerHookHandler(ctx.deps);
    ctx.activeContext.set("ws-1", "tab-1");
    ctx.broker.set("ws-1", "tab-1", "running");
    ctx.broadcastCalls.length = 0;

    ctx.agentHost.emit("claude.hook", makeHookPayload("stop"));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: idle로 직행 (completed 거치지 않음)
    expect(ctx.broker.get("ws-1", "tab-1")?.status).toBe("idle");
    // then: OS 알림 미발사
    expect(ctx.notificationInstances).toHaveLength(0);
  });

  it("session-end → broker entry 제거", async () => {
    // given: 상태 먼저 등록
    ctx.broker.set("ws-1", "tab-1", "running");

    ctx.agentHost.emit("claude.hook", makeHookPayload("session-end"));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: entry가 제거되어야 한다
    expect(ctx.broker.get("ws-1", "tab-1")).toBeNull();
  });

  it("유효하지 않은 payload → 에러 없이 무시", async () => {
    // then: 예외 없이 처리되어야 한다
    expect(() => {
      ctx.agentHost.emit("claude.hook", { invalid: true });
    }).not.toThrow();

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // broker에 아무 변화 없음
    expect(ctx.broker.snapshot()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 시나리오 2: 알림 중복 방지
// ---------------------------------------------------------------------------

describe("시나리오 2: 알림 중복 방지", () => {
  let ctx: ReturnType<typeof makeDeps>;
  let teardown: () => void;

  beforeEach(() => {
    ctx = makeDeps();
    teardown = registerHookHandler(ctx.deps);
  });

  afterEach(() => {
    teardown();
  });

  it("hook notification → OS 알림 1회 발사", async () => {
    // hook 채널로 notification 이벤트 발생
    ctx.agentHost.emit("claude.hook", makeHookPayload("notification", { message: "Done" }));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // OS 알림이 정확히 1회 발사되어야 한다
    expect(ctx.notificationInstances).toHaveLength(1);
    expect(ctx.notificationInstances[0].showCalled).toBe(true);
  });

  it("OSC 9 채널은 hook 채널과 독립 — osc dispatcher handleChunk가 동작함", () => {
    // OSC 알림 dispatcher는 Claude Code와 무관한 일반 PTY 알림 전용 채널이다.
    // 이 테스트는 hook handler가 OSC dispatcher를 건드리지 않음을 검증한다.
    const oscNotifInstances: Array<{ showCalled: boolean }> = [];
    const oscNotifCtor = mock(function(this: unknown, opts: { title: string; body: string }) {
      const inst = { title: opts.title, body: opts.body, showCalled: false };
      oscNotifInstances.push(inst);
      return { on: () => {}, show() { inst.showCalled = true; } };
    }) as unknown as typeof import("electron").Notification;

    const oscDispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "TestWS" },
      getFocusedWindow: () => null,
      electronNotificationCtor: oscNotifCtor,
      broadcastFn: () => {},
    });

    // OSC 9 escape sequence를 직접 PTY 청크로 주입
    const oscChunk = "\x1b]9;Hello from OSC\x07";
    oscDispatcher.handleChunk("ws-1", "tab-1", oscChunk);

    // OSC dispatcher는 자체적으로 알림을 발사해야 한다 (hook 채널과 무관)
    expect(oscNotifInstances).toHaveLength(1);
    expect(oscNotifInstances[0].showCalled).toBe(true);

    // hook handler의 notificationInstances는 영향받지 않아야 한다
    expect(ctx.notificationInstances).toHaveLength(0);
  });

  it("hook notification이 와도 OSC dispatcher는 호출되지 않음 (채널 분리)", async () => {
    // OSC dispatcher의 handleChunk를 spy로 교체
    const handleChunkCalled: boolean[] = [];
    const oscDispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "TestWS" },
      getFocusedWindow: () => null,
      electronNotificationCtor: ctx.deps.electronNotificationCtor,
      broadcastFn: () => {},
    });
    const origHandleChunk = oscDispatcher.handleChunk.bind(oscDispatcher);
    oscDispatcher.handleChunk = (wsId: string, tabId: string, chunk: string) => {
      handleChunkCalled.push(true);
      origHandleChunk(wsId, tabId, chunk);
    };

    // hook notification 이벤트 발사
    ctx.agentHost.emit("claude.hook", makeHookPayload("notification", { message: "test" }));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // hook handler가 OSC dispatcher의 handleChunk를 호출하지 않아야 한다
    expect(handleChunkCalled).toHaveLength(0);

    // OS 알림은 hook handler 자체에서 발사됨
    expect(ctx.notificationInstances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 시나리오 3: PTY exit cleanup
// ---------------------------------------------------------------------------

describe("시나리오 3: PTY exit cleanup", () => {
  it("exit 이벤트 → broker entry 제거", async () => {
    const { deps, broker, agentHost } = makeDeps();

    // broker에 여러 entry 등록
    broker.set("ws-a", "tab-1", "running");
    broker.set("ws-a", "tab-2", "needsInput");
    broker.set("ws-b", "tab-1", "idle");

    // setupClaudeFeature와 동일하게 exit 이벤트를 구독 (index.ts 패턴)
    const offExit = agentHost.on("exit", (args) => {
      const a = args as Record<string, unknown>;
      const workspaceId = typeof a?.workspaceId === "string" ? a.workspaceId : null;
      const tabId = typeof a?.tabId === "string" ? a.tabId : null;
      if (workspaceId && tabId) {
        broker.clear(workspaceId, tabId);
      }
    });

    // ws-a/tab-1 에 대해 exit 이벤트 발사
    agentHost.emit("exit", { workspaceId: "ws-a", tabId: "tab-1" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // then: ws-a/tab-1 entry는 제거되어야 한다
    expect(broker.get("ws-a", "tab-1")).toBeNull();

    // then: ws-a/tab-2와 ws-b/tab-1은 유지되어야 한다
    expect(broker.get("ws-a", "tab-2")?.status).toBe("needsInput");
    expect(broker.get("ws-b", "tab-1")?.status).toBe("idle");

    // ws-b/tab-1 exit
    agentHost.emit("exit", { workspaceId: "ws-b", tabId: "tab-1" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(broker.get("ws-b", "tab-1")).toBeNull();

    // 정리
    offExit();
    deps.dispose?.();
  });

  it("exit 이벤트 payload가 불완전하면 broker에 영향 없음", async () => {
    const { broker, agentHost } = makeDeps();

    broker.set("ws-x", "tab-x", "running");

    const offExit = agentHost.on("exit", (args) => {
      const a = args as Record<string, unknown>;
      const workspaceId = typeof a?.workspaceId === "string" ? a.workspaceId : null;
      const tabId = typeof a?.tabId === "string" ? a.tabId : null;
      if (workspaceId && tabId) {
        broker.clear(workspaceId, tabId);
      }
    });

    // workspaceId만 있고 tabId 없음 — 무시되어야 한다
    agentHost.emit("exit", { workspaceId: "ws-x" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // entry는 그대로여야 한다
    expect(broker.get("ws-x", "tab-x")?.status).toBe("running");

    offExit();
  });
});

// ---------------------------------------------------------------------------
// 시나리오 4: PermissionRequest passthrough
// ---------------------------------------------------------------------------

describe("시나리오 4: PermissionRequest passthrough", () => {
  let ctx: ReturnType<typeof makeDeps>;
  let teardown: () => void;

  beforeEach(() => {
    ctx = makeDeps();
    teardown = registerHookHandler(ctx.deps);
  });

  afterEach(() => {
    teardown();
  });

  it("permission-request → broker permissionPending + respondHook(exitCode:0) 즉시 호출", async () => {
    ctx.agentHost.emit(
      "claude.hook",
      makeHookPayload("permission-request", { tool_name: "Bash" }),
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    // then: broker 상태가 permissionPending이어야 한다
    const entry = ctx.broker.get("ws-1", "tab-1");
    expect(entry?.status).toBe("permissionPending");
    expect(entry?.message).toBe("Claude needs permission: Bash");

    // then: OS 알림이 발사되어야 한다
    expect(ctx.notificationInstances.length).toBeGreaterThanOrEqual(1);

    // then: AgentChannel.call("claude.respondHook", ...) 가 호출되어야 한다
    const respondCalls = ctx.channel.calls.filter((c) => c.method === "claude.respondHook");
    expect(respondCalls).toHaveLength(1);
    const respondParams = respondCalls[0].params as Record<string, unknown>;
    expect(respondParams.hookId).toBe("hook-permission-request-001");
    const response = respondParams.response as Record<string, unknown>;
    expect(response.exitCode).toBe(0);
  });

  it("permission-request — tool_name 없으면 기본 메시지 설정", async () => {
    ctx.agentHost.emit(
      "claude.hook",
      makeHookPayload("permission-request", {}), // tool_name 미포함
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    const entry = ctx.broker.get("ws-1", "tab-1");
    expect(entry?.status).toBe("permissionPending");
    expect(entry?.message).toBe("Claude needs permission");
  });

  it("permission-request — channelProvider가 null 반환해도 에러 없이 진행", async () => {
    // channelProvider가 channel을 찾지 못하는 경우 (워크스페이스 없음)
    const ctxNoChannel = makeDeps({
      channelProvider: {
        tryGetAgentChannel: async () => null,
      },
    });
    const td = registerHookHandler(ctxNoChannel.deps);

    expect(() => {
      ctxNoChannel.agentHost.emit(
        "claude.hook",
        makeHookPayload("permission-request", { tool_name: "Read" }),
      );
    }).not.toThrow();

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    // broker 상태는 설정되어야 한다 (respondHook 실패는 silent)
    expect(ctxNoChannel.broker.get("ws-1", "tab-1")?.status).toBe("permissionPending");

    td();
  });
});

// ---------------------------------------------------------------------------
// 추가: ClaudeStatusBroker 중복 broadcast 방지 검증
// ---------------------------------------------------------------------------

describe("ClaudeStatusBroker: 중복 broadcast 방지", () => {
  it("동일 상태 + 동일 메시지는 broadcast를 생략한다", () => {
    const broadcastCalls: unknown[] = [];
    const broker = new ClaudeStatusBroker((ch, ev, args) => {
      broadcastCalls.push({ ch, ev, args });
    });

    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-1", "running"); // 중복 — broadcast 없어야 함

    expect(broadcastCalls).toHaveLength(1);
  });

  it("상태가 바뀌면 broadcast를 발사한다", () => {
    const broadcastCalls: unknown[] = [];
    const broker = new ClaudeStatusBroker((ch, ev, args) => {
      broadcastCalls.push({ ch, ev, args });
    });

    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-1", "idle");

    expect(broadcastCalls).toHaveLength(2);
  });

  it("snapshot이 모든 활성 entry를 반환한다", () => {
    const broker = new ClaudeStatusBroker(() => {});
    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-2", "idle");
    broker.set("ws-2", "tab-1", "needsInput", "메시지");

    const snap = broker.snapshot();
    expect(snap).toHaveLength(3);

    const needsInputEntry = snap.find(
      (e) => e.workspaceId === "ws-2" && e.tabId === "tab-1",
    );
    expect(needsInputEntry?.status).toBe("needsInput");
    expect(needsInputEntry?.message).toBe("메시지");
  });
});
