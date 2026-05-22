/**
 * hook-handler 단위 테스트.
 *
 * - 7종 subcommand × 상태 전이 매핑 검증.
 * - notification/permission-request의 OS 알림 발사 검증(focus 분기).
 * - 모든 subcommand가 즉시 respondHook { exitCode: 0 } 호출하는지(hook 프로세스 해제).
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";

// electron mock — dynamic import 전에 선언 필요.
mock.module("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    getFocusedWindow: mock(() => null),
    getAllWindows: mock(() => []),
  },
  Notification: class {
    private handlers: Record<string, () => void> = {};
    title: string;
    body: string;
    constructor(opts: { title: string; body: string }) {
      this.title = opts.title;
      this.body = opts.body;
    }
    on(event: string, cb: () => void) {
      this.handlers[event] = cb;
      return this;
    }
    show() {}
  },
}));

const { registerHookHandler } = await import(
  "../../../../src/main/features/claude/hook-handler"
);
const { ClaudeStatusBroker } = await import(
  "../../../../src/main/features/claude/status"
);
const { ActiveContextStore } = await import(
  "../../../../src/main/features/claude/active-context"
);

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function makeNotificationCtor() {
  const instances: Array<{ title: string; body: string; shown: boolean }> = [];
  class FakeNotification {
    title: string;
    body: string;
    private handlers: Record<string, () => void> = {};
    constructor(opts: { title: string; body: string }) {
      this.title = opts.title;
      this.body = opts.body;
      instances.push({ title: opts.title, body: opts.body, shown: false });
    }
    on(event: string, cb: () => void) {
      this.handlers[event] = cb;
      return this;
    }
    show() {
      const last = instances[instances.length - 1];
      if (last) last.shown = true;
    }
    click() {
      this.handlers["click"]?.();
    }
  }
  return { FakeNotification, instances };
}

interface MockAgentChannel {
  callArgs: Array<[string, unknown]>;
  call: (method: string, args: unknown) => Promise<unknown>;
}

function makeChannel(): MockAgentChannel {
  const callArgs: Array<[string, unknown]> = [];
  return {
    callArgs,
    call: mock(async (method: string, args: unknown) => {
      callArgs.push([method, args]);
      return {};
    }),
  };
}

function makeHookPayload(subcommand: string, extra?: unknown) {
  return {
    hookId: `hook-${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws-test",
    tabId: "tab-test",
    subcommand,
    payload: extra ?? {},
  };
}

function makeHookAgentHost() {
  const handlers = new Map<string, Array<(args: unknown) => void>>();
  return {
    on: mock((event: string, cb: (args: unknown) => void) => {
      let list = handlers.get(event);
      if (!list) {
        list = [];
        handlers.set(event, list);
      }
      list.push(cb);
      return () => {
        const l = handlers.get(event);
        if (l) {
          const idx = l.indexOf(cb);
          if (idx !== -1) l.splice(idx, 1);
        }
      };
    }),
    emit: (event: string, args: unknown) => {
      for (const cb of handlers.get(event) ?? []) {
        cb(args);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 테스트 harness
// ---------------------------------------------------------------------------

interface Harness {
  broker: InstanceType<typeof ClaudeStatusBroker>;
  activeContext: InstanceType<typeof ActiveContextStore>;
  brokerCalls: Array<{ channel: string; event: string; args: unknown }>;
  agentHost: ReturnType<typeof makeHookAgentHost>;
  channel: MockAgentChannel;
  notifInstances: Array<{ title: string; body: string; shown: boolean }>;
  FakeNotification: new (opts: { title: string; body: string }) => InstanceType<typeof FakeNotification>;
  broadcastCalls: Array<{ channel: string; event: string; args: unknown }>;
  emit: (payload: unknown) => void;
}

// FakeNotification 타입을 위한 placeholder — 실제로는 makeNotificationCtor에서 반환
class FakeNotification {
  constructor(_opts: { title: string; body: string }) {}
  on(_: string, _cb: () => void) { return this; }
  show() {}
}

function makeHarness(focused: boolean = false): Harness {
  const brokerCalls: Array<{ channel: string; event: string; args: unknown }> = [];
  const broadcastCalls: Array<{ channel: string; event: string; args: unknown }> = [];

  const broadcastFn = mock((ch: string, ev: string, args: unknown) => {
    brokerCalls.push({ channel: ch, event: ev, args });
    broadcastCalls.push({ channel: ch, event: ev, args });
  });

  const broker = new ClaudeStatusBroker(broadcastFn);
  const activeContext = new ActiveContextStore();
  const agentHost = makeHookAgentHost();
  const channel = makeChannel();
  const { FakeNotification: FN, instances: notifInstances } = makeNotificationCtor();

  const getFocusedWindow = focused
    ? () => ({ isMinimized: () => false } as unknown as import("electron").BrowserWindow)
    : () => null;

  registerHookHandler({
    broker,
    activeContext,
    agentHost,
    channelProvider: {
      tryGetAgentChannel: async () => channel as unknown as import("../../../../../src/main/infra/agent/channel").AgentChannel,
    },
    workspaceManager: { getName: () => "TestWorkspace" },
    getFocusedWindow,
    electronNotificationCtor: FN as unknown as typeof import("electron").Notification,
    broadcastFn,
  });

  return {
    broker,
    activeContext,
    brokerCalls,
    agentHost,
    channel,
    notifInstances,
    FakeNotification: FN as unknown as typeof FakeNotification,
    broadcastCalls,
    emit: (payload: unknown) => agentHost.emit("claude.hook", payload),
  };
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

describe("hook-handler — subcommand 상태 전이", () => {
  test("session-start → running", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("session-start"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("user-prompt-submit → running", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("stop — 사용자가 그 탭을 보고 있으면(앱 포커스+active 일치) idle로 직행", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("idle");
  });

  test("stop — 다른 탭을 보고 있으면 completed로 전이", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab"); // 다른 탭
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("completed");
  });

  test("stop — 앱 비포커스 상태이면 active 일치해도 completed로 전이", async () => {
    const { broker, activeContext, emit } = makeHarness(false /* unfocused */);
    activeContext.set("ws-test", "tab-test"); // 동일 탭이지만
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    // 앱이 백그라운드면 사용자가 보고 있지 않다고 본다.
    expect(broker.get("ws-test", "tab-test")?.status).toBe("completed");
  });

  test("session-end → broker.clear (항목 제거)", async () => {
    const { broker, emit } = makeHarness();
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("session-end"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")).toBeNull();
  });

  test("notification → needsInput + message", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("notification", { message: "Waiting for input" }));
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("needsInput");
    expect(entry?.message).toBe("Waiting for input");
  });

  test("permission-request → permissionPending + tool_name message", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("permission-request", { tool_name: "Bash" }));
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("permissionPending");
    expect(entry?.message).toContain("Bash");
  });

  test("pre-tool-use → running", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("pre-tool-use"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });
});

describe("hook-handler — respondHook 호출", () => {
  test("pre-tool-use: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("pre-tool-use"));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("permission-request: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("permission-request", { tool_name: "Bash" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("session-start: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("session-start"));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("user-prompt-submit: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit"));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("notification: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("notification", { message: "ping" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("stop: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("session-end: 즉시 claude.respondHook { exitCode:0 } 호출", async () => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload("session-end"));
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.callArgs.length).toBeGreaterThanOrEqual(1);
    const [method, args] = channel.callArgs[0];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });
});

describe("hook-handler — Notification OS 알림 발사(active context 분기)", () => {
  test("앱 비포커스 시 notification hook OS 알림 발사", async () => {
    const { notifInstances, emit } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("notification", { message: "task done" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
    expect(notifInstances[0].shown).toBe(true);
  });

  test("앱 포커스 + active 다른 탭 시 notification hook OS 알림 발사", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    emit(makeHookPayload("notification", { message: "task done" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
  });

  test("앱 포커스 + active 일치 시 notification hook OS 알림 미발사", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("notification", { message: "task done" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances).toHaveLength(0);
  });

  test("앱 비포커스 시 permission-request hook OS 알림 발사", async () => {
    const { notifInstances, emit } = makeHarness(false);
    emit(makeHookPayload("permission-request", { tool_name: "Bash" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
    expect(notifInstances[0].title).toContain("Permission");
  });

  test("앱 포커스 + active 다른 탭 시 permission-request OS 알림 발사", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    emit(makeHookPayload("permission-request", { tool_name: "Bash" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
    expect(notifInstances[0].title).toContain("Permission");
  });

  test("앱 포커스 + active 일치 시 permission-request OS 알림 미발사", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("permission-request", { tool_name: "Bash" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances).toHaveLength(0);
  });
});

describe("hook-handler — Stop 알림 발사(active context 분기)", () => {
  test("사용자가 그 탭을 보고 있으면 Stop 알림 미발사", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances).toHaveLength(0);
  });

  test("사용자가 다른 탭을 보고 있으면 Stop OS 알림 발사", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
    expect(notifInstances[0].body).toBe("Response complete");
  });

  test("앱 비포커스 시 Stop OS 알림 발사 (active 일치 무관)", async () => {
    const { notifInstances, activeContext, emit } = makeHarness(false /* unfocused */);
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
  });

  test("active context 미설정 시 Stop OS 알림 발사", async () => {
    const { notifInstances, emit } = makeHarness(true /* focused */);
    // activeContext.set 호출 안 함 → null
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBeGreaterThanOrEqual(1);
  });
});

describe("hook-handler — 유효하지 않은 payload 무시", () => {
  test("null payload 무시", async () => {
    const { broker, emit } = makeHarness();
    emit(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.snapshot()).toHaveLength(0);
  });

  test("알 수 없는 subcommand 무시", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("unknown-future-subcommand"));
    await new Promise((r) => setTimeout(r, 0));
    // 상태 변화 없어야 함.
    expect(broker.snapshot()).toHaveLength(0);
  });
});
