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
const { PROMPT_MAX_CHARS } = await import("../../../../src/shared/claude/status");
const { SessionActivityLog } = await import(
  "../../../../src/main/features/claude/session-activity"
);
const { PermissionAsks } = await import("../../../../src/main/features/claude/permission-asks");
const { ChatAnswers } = await import("../../../../src/main/features/claude/chat-answers");

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
  activity: InstanceType<typeof SessionActivityLog>;
  asks: InstanceType<typeof PermissionAsks> | undefined;
  chatAnswers: InstanceType<typeof ChatAnswers>;
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

function makeHarness(
  focused: boolean = false,
  opts: { notificationsEnabled?: () => boolean; asks?: boolean } = {},
): Harness {
  const brokerCalls: Array<{ channel: string; event: string; args: unknown }> = [];
  const broadcastCalls: Array<{ channel: string; event: string; args: unknown }> = [];

  const broadcastFn = mock((ch: string, ev: string, args: unknown) => {
    brokerCalls.push({ channel: ch, event: ev, args });
    broadcastCalls.push({ channel: ch, event: ev, args });
  });

  const broker = new ClaudeStatusBroker(broadcastFn);
  const activeContext = new ActiveContextStore();
  const activity = new SessionActivityLog();
  const agentHost = makeHookAgentHost();
  const channel = makeChannel();
  const { FakeNotification: FN, instances: notifInstances } = makeNotificationCtor();
  const asks = opts.asks
    ? new PermissionAsks(async (_workspaceId, hookId, response) => {
        await channel.call("claude.respondHook", { hookId, response });
        return true;
      })
    : undefined;
  const chatAnswers = new ChatAnswers();

  const getFocusedWindow = focused
    ? () => ({ isMinimized: () => false } as unknown as import("electron").BrowserWindow)
    : () => null;

  registerHookHandler({
    broker,
    activeContext,
    activity,
    asks,
    chatAnswers,
    agentHost,
    channelProvider: {
      tryGetAgentChannel: async () => channel as unknown as import("../../../../../src/main/infra/agent/channel").AgentChannel,
    },
    workspaceManager: { getName: () => "TestWorkspace" },
    getFocusedWindow,
    electronNotificationCtor: FN as unknown as typeof import("electron").Notification,
    broadcastFn,
    notificationsEnabled: opts.notificationsEnabled,
  });

  return {
    broker,
    activeContext,
    activity,
    asks,
    chatAnswers,
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
    // session-start는 idle — Claude가 사용자 입력 대기 상태로 들어간다.
    // running은 user-prompt-submit/pre-tool-use부터 실제 작업이 시작될 때.
    expect(broker.get("ws-test", "tab-test")?.status).toBe("idle");
  });

  test("user-prompt-submit → running", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("user-prompt-submit — prompt를 다듬어 기록, 길면 잘라냄", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "  fix the build \n" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe("fix the build");

    emit(makeHookPayload("user-prompt-submit", { prompt: "x".repeat(PROMPT_MAX_CHARS + 10) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe(`${"x".repeat(PROMPT_MAX_CHARS)}…`);
  });

  test("user-prompt-submit keeps pasted text without Claude Code's marks", async () => {
    const { broker, emit } = makeHarness();
    const prompt =
      'see this:\n<pasted_content id="edf0">\n1. first\n2. second\n</pasted_content id="edf0">\nthanks';
    emit(makeHookPayload("user-prompt-submit", { prompt }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe("see this:\n1. first\n2. second\nthanks");

    // Only a pair with the same id is a paste; a lone mark is the user's text.
    emit(makeHookPayload("user-prompt-submit", { prompt: 'why is <pasted_content id="a"> shown?' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe('why is <pasted_content id="a"> shown?');
  });

  test.each([
    "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>",
    '<cross-session-message from="worker">done</cross-session-message>',
    // As Claude Code 2.1.316 delivers a background agent's SendMessage.
    'Another Claude session sent a message:\n<agent-message from="a58">Question for you</agent-message>',
    "A peer session sent a message while you were working:\nbuild is green",
    '<teammate-message teammate_id="tester">tests pass</teammate-message>',
    '<channel source="ci">deploy finished</channel>',
    "<tick>1793550051</tick>",
    "The linter plugin sent a message:\nfix the import order",
  ])("a turn Claude Code starts itself runs but keeps the user's prompt: %j", async (prompt) => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    await new Promise((r) => setTimeout(r, 0));
    broker.set("ws-test", "tab-test", "completed", "Built.");
    emit(makeHookPayload("user-prompt-submit", { prompt }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe("build it");
  });

  test.each([
    "<b>bold</b> is not shown in the preview",
    "The build plugin sent a message: is that why it fails?",
    "Another Claude session sent a message earlier, did you read it?",
  ])("the user's own words that only look like an envelope are kept: %j", async (prompt) => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe(prompt);
  });

  test("session-start — 이전 세션의 prompt를 비움", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "old" }));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("session-start"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.prompt).toBeUndefined();
  });

  test("session-start after compaction keeps the running turn and its prompt", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "refactor the parser" }));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("session-start", { source: "compact" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe("refactor the parser");
  });

  test.each(["startup", "resume", "clear"])(
    "session-start from %s goes idle without the old prompt",
    async (source) => {
      const { broker, emit } = makeHarness();
      emit(makeHookPayload("user-prompt-submit", { prompt: "old" }));
      await new Promise((r) => setTimeout(r, 0));
      emit(makeHookPayload("session-start", { source }));
      await new Promise((r) => setTimeout(r, 0));
      expect(broker.get("ws-test", "tab-test")?.status).toBe("idle");
      expect(broker.get("ws-test", "tab-test")?.prompt).toBeUndefined();
    },
  );

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

  test("stop — 비-active 탭 + assistantText 있음 → completed + message에 텍스트", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab"); // 다른 탭
    broker.set("ws-test", "tab-test", "running");
    // hookclient가 transcript를 읽어 채워서 보낸 payload를 시뮬레이션.
    emit({
      ...makeHookPayload("stop"),
      assistantText: "Here is the answer to your question.",
    });
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("completed");
    expect(entry?.message).toBe("Here is the answer to your question.");
  });

  test("stop — 비-active 탭 + assistantText 미포함 → completed + message undefined", async () => {
    // transcript가 없거나 파싱 실패 등 silent fallback 경로. 글리프만 표시되어야.
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop")); // assistantText 미포함
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("completed");
    expect(entry?.message).toBeUndefined();
  });

  test("stop on the tab the user is looking at keeps the answer", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    broker.set("ws-test", "tab-test", "running");
    emit({ ...makeHookPayload("stop"), assistantText: "Done: 2 files changed." });
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("idle");
    expect(entry?.message).toBe("Done: 2 files changed.");
  });

  test("stop without an answer drops the previous turn's", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    broker.set("ws-test", "tab-test", "completed", "the old answer");
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.message).toBeUndefined();
  });

  // Claude Code fires StopFailure instead of Stop when the turn ends on an
  // API error, such as a rate limit.
  test("stop-failure ends the turn on the error and notifies with it", async () => {
    const { broker, activeContext, emit, notifInstances } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    await new Promise((r) => setTimeout(r, 0));
    emit(
      makeHookPayload("stop-failure", {
        error: "rate_limit",
        last_assistant_message: "API Error: Request rejected (429) · Rate limited",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("error");
    expect(entry?.message).toBe("API Error: Request rejected (429) · Rate limited");
    expect(entry?.prompt).toBe("build it");
    expect(notifInstances).toHaveLength(1);
    expect(notifInstances[0].body).toBe("API Error: Request rejected (429) · Rate limited");
  });

  test("stop-failure without a message tells the error type", async () => {
    const { broker, emit } = makeHarness();
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop-failure", { error: "rate_limit" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.message).toBe("rate_limit");

    emit(makeHookPayload("stop-failure", {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("error");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("Claude stopped on an error");
  });

  test("stop-failure on the tab the user is looking at keeps the error and notifies no one", async () => {
    const { broker, activeContext, emit, notifInstances } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop-failure", { error: "server_error" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("error");
    expect(notifInstances).toHaveLength(0);
  });

  test("the next prompt after stop-failure runs again", async () => {
    const { broker, emit } = makeHarness();
    broker.set("ws-test", "tab-test", "running");
    emit(makeHookPayload("stop-failure", { error: "rate_limit" }));
    emit(makeHookPayload("user-prompt-submit", { prompt: "try again" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
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

  test.each([
    ["idle_prompt", "Claude is waiting for your input"],
    ["elicitation_dialog", "MCP server needs your input"],
    ["agent_needs_input", "worker needs your input"],
  ])("notification of type %s waits on the user", async (notification_type, message) => {
    const { broker, emit } = makeHarness();
    broker.set("ws-test", "tab-test", "completed", "Done.");
    emit(makeHookPayload("notification", { message, notification_type }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("needsInput");
    expect(broker.get("ws-test", "tab-test")?.message).toBe(message);
  });

  test.each([
    ["push_notification", "Build finished, 3 tests fail"],
    ["agent_completed", "worker finished"],
    ["auth_success", "Claude Code login successful"],
    ["model_refusal_fallback", "Switched to another model"],
    ["plugin_notification", "Deployed"],
  ])("notification of type %s only tells, and the turn runs on", async (notification_type, message) => {
    const { broker, activeContext, emit, notifInstances } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "other-tab");
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("notification", { message, notification_type }));
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("running");
    expect(entry?.message).toBeUndefined();
    expect(notifInstances).toHaveLength(1);
    expect(notifInstances[0].body).toBe(message);
  });

  test("a notification that only tells leaves a finished turn as it is, and is quiet on the tab the user looks at", async () => {
    const { broker, activeContext, emit, notifInstances } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    broker.set("ws-test", "tab-test", "completed", "Done.");
    emit(
      makeHookPayload("notification", {
        message: "Claude Code login successful",
        notification_type: "auth_success",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("completed");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("Done.");
    expect(notifInstances).toHaveLength(0);
  });

  test("permission notification after permission-request keeps permissionPending", async () => {
    const { broker, emit, notifInstances } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("permission-request", { tool_name: "Write" }));
    await new Promise((r) => setTimeout(r, 0));
    emit(
      makeHookPayload("notification", {
        message: "Claude needs your permission to use Write",
        notification_type: "permission_prompt",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("permissionPending");
    expect(entry?.message).toContain("Write");
    expect(notifInstances).toHaveLength(1);
  });

  test.each([
    "permission_prompt",
    "worker_permission_prompt",
  ])("%s notification alone → permissionPending + OS notification", async (type) => {
    const { broker, emit, notifInstances } = makeHarness(false /* unfocused */);
    emit(
      makeHookPayload("notification", {
        message: "Claude needs your permission to use Bash",
        notification_type: type,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("permissionPending");
    expect(entry?.message).toBe("Claude needs your permission to use Bash");
    expect(notifInstances).toHaveLength(1);
    expect(notifInstances[0].title).toContain("Permission");
  });

  test("idle_prompt notification → needsInput", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("permission-request", { tool_name: "Bash" }));
    await new Promise((r) => setTimeout(r, 0));
    emit(
      makeHookPayload("notification", {
        message: "Claude is waiting for your input",
        notification_type: "idle_prompt",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("needsInput");
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

  const allowedCall = { tool_name: "Bash", tool_input: { command: "bun test" } };

  test("post-tool-use of the tool the dialog was for → running", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("post-tool-use", { ...allowedCall, tool_use_id: "toolu_1" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("post-tool-use of a tool run beside it keeps permissionPending", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("post-tool-use", { tool_name: "Read", tool_input: { file_path: "/a" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("permissionPending");
    emit(makeHookPayload("post-tool-use", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("a late post-tool-use leaves the turn's end as it is", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("post-tool-use", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("completed");
  });

  test("a dialog the user denied does not hold the next turn's", async () => {
    const { broker, emit } = makeHarness();
    // Denied: its tool never runs.
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    emit(makeHookPayload("user-prompt-submit", { prompt: "try another way" }));
    await new Promise((r) => setTimeout(r, 0));
    // A dialog told only by its notification, with no PermissionRequest.
    emit(makeHookPayload("notification", { notification_type: "permission_prompt" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("permissionPending");
    emit(makeHookPayload("post-tool-use", { tool_name: "Read", tool_input: { file_path: "/a" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("an answer in a Claude tab ends the wait at once, before the call ends", async () => {
    const { broker, emit, chatAnswers } = makeHarness();
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    chatAnswers.answered("ws-test", "tab-test", false);
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
    // The call's end, later, leaves it so.
    emit(makeHookPayload("post-tool-use", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  test("an answer in a Claude tab that stops the turn leaves the session waiting", async () => {
    const { broker, emit, chatAnswers } = makeHarness();
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    chatAnswers.answered("ws-test", "tab-test", true);
    expect(broker.get("ws-test", "tab-test")?.status).toBe("idle");
  });

  test("an answer in another tab leaves the dialog open", async () => {
    const { broker, emit, chatAnswers } = makeHarness();
    emit(makeHookPayload("permission-request", allowedCall));
    await new Promise((r) => setTimeout(r, 0));
    chatAnswers.answered("ws-test", "tab-other", false);
    expect(broker.get("ws-test", "tab-test")?.status).toBe("permissionPending");
  });
});

describe("hook-handler — subagents and permission dialogs", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const bash = { tool_name: "Bash", tool_input: { command: "touch made.txt" } };
  const read = { tool_name: "Read", tool_input: { file_path: "/a" } };
  const status = (broker: Harness["broker"]) => broker.get("ws-test", "tab-test")?.status;

  test("a subagent's tool after the turn ended leaves the turn's end", async () => {
    const { broker, emit } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit({ ...makeHookPayload("stop"), assistantText: "Started an agent." });
    emit(makeHookPayload("pre-tool-use", { ...read, agent_id: "a1" }));
    emit(makeHookPayload("post-tool-use", { ...read, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("completed");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("Started an agent.");
  });

  // Claude Code 2.1.316: a background agent's dialog opens after the turn's
  // Stop, and its tool's PostToolUse comes once the user allows it.
  test("a background agent's dialog after the turn ended waits on the user, then gives the end back", async () => {
    const { broker, emit } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit({ ...makeHookPayload("stop"), assistantText: "Started an agent." });
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("permissionPending");
    emit(makeHookPayload("notification", { notification_type: "permission_prompt" }));
    emit(makeHookPayload("post-tool-use", { ...bash, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("completed");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("Started an agent.");
  });

  test("on the tab the user looks at, the turn's end comes back as seen", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    activeContext.set("ws-test", "other-tab");
    emit({ ...makeHookPayload("stop"), assistantText: "Started an agent." });
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    await tick();
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("post-tool-use", { ...bash, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("idle");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("Started an agent.");
  });

  test("a tool another agent runs does not hide the dialog", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", bash));
    emit(makeHookPayload("pre-tool-use", { ...read, agent_id: "a1" }));
    emit(makeHookPayload("post-tool-use", { ...read, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("permissionPending");
    emit(makeHookPayload("post-tool-use", bash));
    await tick();
    expect(status(broker)).toBe("running");
  });

  test("the session's tool does not hide a subagent's dialog", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    emit(makeHookPayload("pre-tool-use", read));
    emit(makeHookPayload("post-tool-use", read));
    await tick();
    expect(status(broker)).toBe("permissionPending");
    emit(makeHookPayload("post-tool-use", { ...bash, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("running");
  });

  test("the turn's Stop does not hide a subagent's dialog, and shows once it closes", async () => {
    const { broker, emit } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    emit({ ...makeHookPayload("stop"), assistantText: "Done." });
    await tick();
    expect(status(broker)).toBe("permissionPending");
    // Denied: the agent ends without running the tool.
    emit(makeHookPayload("subagent-stop", { agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("completed");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("Done.");
  });

  test("a turn's StopFailure does not hide a subagent's dialog, and shows once it closes", async () => {
    const { broker, emit } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    emit(makeHookPayload("stop-failure", { error: "rate_limit" }));
    await tick();
    expect(status(broker)).toBe("permissionPending");
    emit(makeHookPayload("subagent-stop", { agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("error");
    expect(broker.get("ws-test", "tab-test")?.message).toBe("rate_limit");
  });

  test("a subagent that goes on to another tool is past its dialog", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    emit(makeHookPayload("pre-tool-use", { ...read, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("running");
  });

  test("a late PreToolUse of the call the dialog is for keeps it", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", bash));
    emit(makeHookPayload("pre-tool-use", bash));
    await tick();
    expect(status(broker)).toBe("permissionPending");
    // Denied with what to do instead: the turn goes on to another tool.
    emit(makeHookPayload("pre-tool-use", read));
    await tick();
    expect(status(broker)).toBe("running");
  });

  test("an allowed tool that fails ends the wait", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", bash));
    emit(makeHookPayload("post-tool-use-failure", { ...bash, error: "exit 1" }));
    await tick();
    expect(status(broker)).toBe("running");
  });

  test("a turn Claude Code starts while a subagent's dialog is open keeps the dialog", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("stop"));
    emit(makeHookPayload("permission-request", { ...bash, agent_id: "a1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt: "and test it" }));
    await tick();
    expect(status(broker)).toBe("permissionPending");
    expect(broker.get("ws-test", "tab-test")?.prompt).toBe("and test it");
    emit(makeHookPayload("post-tool-use", { ...bash, agent_id: "a1" }));
    await tick();
    expect(status(broker)).toBe("running");
  });

  test("a dialog the turn's interrupt closed is not waited on", async () => {
    const { broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("permission-request", bash));
    await tick();
    // The interrupt watcher saw the turn end.
    broker.set("ws-test", "tab-test", "idle");
    emit(makeHookPayload("user-prompt-submit", { prompt: "again" }));
    emit(makeHookPayload("pre-tool-use", bash));
    await tick();
    expect(status(broker)).toBe("running");
  });
});

describe("hook-handler — respondHook 호출", () => {
  test.each([
    ["pre-tool-use", undefined],
    ["post-tool-use", undefined],
    ["post-tool-use-failure", undefined],
    ["subagent-start", { agent_id: "a1" }],
    ["subagent-stop", { agent_id: "a1" }],
    ["permission-request", { tool_name: "Bash" }],
    ["session-start", undefined],
    ["user-prompt-submit", undefined],
    ["notification", { message: "ping" }],
    ["stop", undefined],
    ["session-end", undefined],
    ["print-start", { run_id: "p1" }],
    ["print-tool-use", { run_id: "p1", tool_name: "Read" }],
    ["print-end", { run_id: "p1", exit_code: 0 }],
  ])("%s: 즉시 claude.respondHook { exitCode:0 } 호출", async (subcommand, extra) => {
    const { channel, emit } = makeHarness();
    emit(makeHookPayload(subcommand, extra));
    await new Promise((r) => setTimeout(r, 0));
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

  test("needsInput while the user views the tab leaves no badge, as Stop does", async () => {
    const { broker, activeContext, emit } = makeHarness(true /* focused */);
    activeContext.set("ws-test", "tab-test");
    emit(makeHookPayload("notification", { message: "Claude is waiting for your input" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get("ws-test", "tab-test")?.status).toBe("idle");
  });

  test("needsInput stays while the user is in another app or tab", async () => {
    for (const [focused, active] of [
      [false, "tab-test"],
      [true, "other-tab"],
    ] as const) {
      const { broker, activeContext, emit } = makeHarness(focused);
      activeContext.set("ws-test", active);
      emit(makeHookPayload("notification", { message: "Claude is waiting for your input" }));
      await new Promise((r) => setTimeout(r, 0));
      expect(broker.get("ws-test", "tab-test")?.status).toBe("needsInput");
    }
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

// ---------------------------------------------------------------------------
// notificationsEnabled 마스터 토글
//
// 가드는 fireOsNotification 진입 직전에 위치한다. OS 알림 발사만 차단되고
// broker/active-context/응답 처리는 그대로 진행되어야 한다 — in-app 인디케이터
// (사이드바 attention 등)가 토글 영향을 받지 않는 게 의도된 동작이다.
// ---------------------------------------------------------------------------

describe("hook-handler — notificationsEnabled 마스터 토글", () => {
  test("토글 off 시 Notification 훅의 OS 알림이 발사되지 않는다", async () => {
    const { notifInstances, broker, emit } = makeHarness(false, {
      notificationsEnabled: () => false,
    });
    emit(
      makeHookPayload("notification", { message: "ping" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBe(0);
    // broker는 정상 갱신 — 사이드바 인디케이터는 토글 영향 없음.
    expect(broker.snapshot().length).toBeGreaterThan(0);
  });

  test("토글 off 시 Permission Request OS 알림이 발사되지 않는다", async () => {
    const { notifInstances, broker, emit } = makeHarness(false, {
      notificationsEnabled: () => false,
    });
    emit(
      makeHookPayload("permission-request", {
        tool_name: "Bash",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBe(0);
    expect(broker.snapshot().length).toBeGreaterThan(0);
  });

  test("토글 off 시 Stop(응답 완료) OS 알림이 발사되지 않는다", async () => {
    const { notifInstances, broker, emit } = makeHarness(false, {
      notificationsEnabled: () => false,
    });
    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBe(0);
    expect(broker.snapshot().length).toBeGreaterThan(0);
  });

  test("토글 getter가 매번 평가된다 — 도중에 false→true 전환되면 다음 발사부터 즉시 반영", async () => {
    let enabled = false;
    const { notifInstances, emit } = makeHarness(false, {
      notificationsEnabled: () => enabled,
    });

    emit(makeHookPayload("stop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBe(0);

    enabled = true;
    emit({ ...makeHookPayload("stop"), tabId: "tab-test-2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(notifInstances.length).toBe(1);
  });
});

describe("hook-handler — frames of a finished turn", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("Stop that loses the race to the next prompt changes nothing and notifies no one", async () => {
    const { broker, emit, notifInstances, channel } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt: "first", prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt: "second", prompt_id: "p2" }));
    emit(makeHookPayload("stop", { prompt_id: "p1" }));
    await tick();
    const entry = broker.get("ws-test", "tab-test");
    expect(entry?.status).toBe("running");
    expect(entry?.prompt).toBe("second");
    expect(notifInstances).toHaveLength(0);
    // Still answered, so the hook process exits.
    expect(channel.callArgs).toHaveLength(3);
  });

  test("StopFailure of the previous turn keeps the next one running", async () => {
    const { broker, emit, notifInstances } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p2" }));
    emit(makeHookPayload("stop-failure", { error: "rate_limit", prompt_id: "p1" }));
    await tick();
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
    expect(notifInstances).toHaveLength(0);
  });

  test("late idle notification of the previous turn keeps the next one running", async () => {
    const { broker, emit, notifInstances } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("stop", { prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p2" }));
    await tick();
    const notified = notifInstances.length;
    emit(
      makeHookPayload("notification", {
        message: "Claude is waiting for your input",
        notification_type: "idle_prompt",
        prompt_id: "p1",
      }),
    );
    await tick();
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
    expect(notifInstances).toHaveLength(notified);
  });

  test("Stop of the turn under way still completes and notifies", async () => {
    const { broker, emit, notifInstances } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p2" }));
    // A tool frame with an id not seen yet does not end the turn under way.
    emit(makeHookPayload("pre-tool-use", { prompt_id: "p0" }));
    emit(makeHookPayload("stop", { prompt_id: "p2" }));
    await tick();
    expect(broker.get("ws-test", "tab-test")?.status).toBe("completed");
    expect(notifInstances).toHaveLength(1);
  });

  test("frames without prompt_id (older Claude Code) are never dropped", async () => {
    const { broker, emit } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p2" }));
    emit(makeHookPayload("stop", {}));
    await tick();
    expect(broker.get("ws-test", "tab-test")?.status).toBe("completed");
  });

  test("PermissionRequest of a finished turn is still answered with exit 0", async () => {
    const { broker, emit, channel } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p2" }));
    emit(makeHookPayload("permission-request", { tool_name: "Bash", prompt_id: "p1" }));
    await tick();
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
    const [method, args] = channel.callArgs[2];
    expect(method).toBe("claude.respondHook");
    expect((args as { response: { exitCode: number } }).response.exitCode).toBe(0);
  });

  test("Stop that arrives after SessionEnd does not bring the tab back", async () => {
    const { broker, emit, notifInstances } = makeHarness(false /* unfocused */);
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("session-end", { prompt_id: "p1" }));
    emit(makeHookPayload("stop", { prompt_id: "p1" }));
    await tick();
    expect(broker.get("ws-test", "tab-test")).toBeNull();
    expect(notifInstances).toHaveLength(0);
  });
});

describe("hook-handler — session activity", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("records the tools and agents the hooks tell of", async () => {
    const { activity, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "go", prompt_id: "p1" }));
    emit(
      makeHookPayload("pre-tool-use", {
        prompt_id: "p1",
        tool_name: "Bash",
        tool_use_id: "t1",
        tool_input: { command: "ls" },
      }),
    );
    emit(makeHookPayload("subagent-start", { agent_id: "a1", agent_type: "Explore" }));
    await tick();
    const recorded = activity.get("ws-test", "tab-test");
    expect(recorded?.tools.map((tool) => tool.target)).toEqual(["ls"]);
    expect(recorded?.agents.map((agent) => agent.id)).toEqual(["a1"]);
  });

  test("a frame of a finished turn is not recorded", async () => {
    const { activity, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p1" }));
    emit(makeHookPayload("user-prompt-submit", { prompt_id: "p2" }));
    emit(
      makeHookPayload("pre-tool-use", {
        prompt_id: "p1",
        tool_name: "Bash",
        tool_use_id: "t1",
        tool_input: { command: "ls" },
      }),
    );
    await tick();
    expect(activity.get("ws-test", "tab-test")?.tools).toEqual([]);
  });
});

describe("hook-handler — `claude -p` runs inside a session", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("are recorded as the session's agents, and leave its state as it is", async () => {
    const { activity, broker, emit } = makeHarness();
    emit(makeHookPayload("user-prompt-submit", { prompt: "go", prompt_id: "p1" }));
    await tick();
    emit(makeHookPayload("print-start", { run_id: "r1", prompt: "review", tools_told: true }));
    emit(makeHookPayload("print-tool-use", { run_id: "r1", tool_use_id: "u1", tool_name: "Read" }));
    emit(makeHookPayload("print-end", { run_id: "r1", exit_code: 0, answer: "ok" }));
    await tick();
    expect(activity.get("ws-test", "tab-test")?.agents[0]).toMatchObject({
      id: "r1",
      kind: "print",
      state: "completed",
      toolCount: 1,
      answer: "ok",
    });
    expect(broker.get("ws-test", "tab-test")?.status).toBe("running");
  });

  // A run killed before it tells its end, as by SIGKILL.
  test("hold a run's watch unanswered, and stop a run whose watch went away", async () => {
    const { activity, agentHost, channel, emit } = makeHarness();
    emit(makeHookPayload("print-start", { run_id: "r1" }));
    const watch = makeHookPayload("print-watch", { run_id: "r1" });
    emit(watch);
    await tick();
    const answered = channel.callArgs.filter(
      ([method, args]) =>
        method === "claude.respondHook" && (args as { hookId: string }).hookId === watch.hookId,
    );
    expect(answered).toEqual([]);
    expect(activity.get("ws-test", "tab-test")?.agents[0]?.state).toBe("running");
    agentHost.emit("claude.hookGone", {
      hookId: watch.hookId,
      workspaceId: "ws-test",
      tabId: "tab-test",
      subcommand: "print-watch",
      payload: { run_id: "r1" },
    });
    expect(activity.get("ws-test", "tab-test")?.agents[0]?.state).toBe("stopped");
  });
});

describe("hook-handler — permission requests answered from the app", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const bash = { tool_name: "Bash", tool_input: { command: "touch made.txt" } };
  const status = (broker: Harness["broker"]) => broker.get("ws-test", "tab-test")?.status;
  const answersTo = (channel: MockAgentChannel, hookId: string) =>
    channel.callArgs
      .filter(
        ([method, args]) =>
          method === "claude.respondHook" && (args as { hookId: string }).hookId === hookId,
      )
      .map(([, args]) => (args as { response: unknown }).response);

  test("holds a request for the user's answer beside the dialog", async () => {
    const { asks, channel, emit } = makeHarness(false, { asks: true });
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    await tick();
    expect(answersTo(channel, request.hookId)).toEqual([]);
    expect(asks?.list("ws-test", "tab-test")).toMatchObject([
      { id: request.hookId, tool: "Bash", target: "touch made.txt", always: [] },
    ]);
  });

  // A `claude -p` run shows no dialog and waits on the hook.
  test("answers a print run's request at once", async () => {
    const { asks, channel, emit } = makeHarness(false, { asks: true });
    const request = { ...makeHookPayload("permission-request", bash), print: true };
    emit(request);
    await tick();
    expect(answersTo(channel, request.hookId)).toEqual([{ exitCode: 0 }]);
    expect(asks?.list("ws-test", "tab-test")).toEqual([]);
  });

  test("lets go of a request answered in the terminal", async () => {
    const { asks, broker, channel, emit } = makeHarness(false, { asks: true });
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    emit(makeHookPayload("post-tool-use", bash));
    await tick();
    expect(answersTo(channel, request.hookId)).toEqual([{ exitCode: 0 }]);
    expect(asks?.list("ws-test", "tab-test")).toEqual([]);
    expect(status(broker)).toBe("running");
  });

  // Enter or a digit typed at the dialog: the call allowed may run long before its hook.
  test("a key that answers the dialog in the terminal closes it at once", async () => {
    const { activity, asks, broker, channel, emit } = makeHarness(false, { asks: true });
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("subagent-start", { agent_id: "a1", agent_type: "Explore" }));
    const request = makeHookPayload("permission-request", { ...bash, agent_id: "a1" });
    emit(request);
    await tick();
    expect(status(broker)).toBe("permissionPending");
    asks?.answeredInTerminal("ws-test", "tab-test");
    expect(answersTo(channel, request.hookId)).toEqual([{ exitCode: 0 }]);
    expect(asks?.list("ws-test", "tab-test")).toEqual([]);
    expect(status(broker)).toBe("running");
    expect(activity.get("ws-test", "tab-test")?.agents[0]?.state).toBe("running");
  });

  test("an answer from the app closes the dialog at once", async () => {
    const { asks, broker, channel, emit } = makeHarness(false, { asks: true });
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    await tick();
    expect(status(broker)).toBe("permissionPending");
    expect(await asks?.answer("ws-test", "tab-test", request.hookId, "allow")).toBe(true);
    expect(answersTo(channel, request.hookId)).toEqual([
      {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        }),
        exitCode: 0,
      },
    ]);
    expect(status(broker)).toBe("running");
    // The tool then runs; its end changes nothing more.
    emit(makeHookPayload("post-tool-use", bash));
    await tick();
    expect(answersTo(channel, request.hookId)).toHaveLength(1);
    expect(status(broker)).toBe("running");
  });

  test("stopping the turn from the app leaves the session waiting on the user", async () => {
    const { asks, broker, emit } = makeHarness(false, { asks: true });
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    await tick();
    expect(await asks?.answer("ws-test", "tab-test", request.hookId, "denyStop")).toBe(true);
    expect(status(broker)).toBe("idle");
  });

  test("a subagent the user answered for goes on", async () => {
    const { activity, asks, emit } = makeHarness(false, { asks: true });
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("subagent-start", { agent_id: "a1", agent_type: "Explore" }));
    const request = makeHookPayload("permission-request", { ...bash, agent_id: "a1" });
    emit(request);
    await tick();
    expect(asks?.list("ws-test", "tab-test")[0]?.agentId).toBe("a1");
    expect(activity.get("ws-test", "tab-test")?.agents[0]?.state).toBe("permissionPending");
    expect(await asks?.answer("ws-test", "tab-test", request.hookId, "deny", "Use ls")).toBe(true);
    expect(activity.get("ws-test", "tab-test")?.agents[0]?.state).toBe("running");
  });

  test("a call denied from the app reads as denied", async () => {
    const { activity, asks, emit } = makeHarness(false, { asks: true });
    emit(makeHookPayload("user-prompt-submit", { prompt: "build it" }));
    emit(makeHookPayload("pre-tool-use", { ...bash, tool_use_id: "t1" }));
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    await tick();
    expect(await asks?.answer("ws-test", "tab-test", request.hookId, "deny")).toBe(true);
    expect(activity.get("ws-test", "tab-test")?.tools[0]?.denied).toBe(true);
  });

  // Claude Code ends the hook as the user interrupts at the dialog.
  test("forgets a request whose hook went away", async () => {
    const { agentHost, asks, channel, emit } = makeHarness(false, { asks: true });
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    await tick();
    agentHost.emit("claude.hookGone", {
      hookId: request.hookId,
      workspaceId: "ws-test",
      tabId: "tab-test",
    });
    expect(asks?.list("ws-test", "tab-test")).toEqual([]);
    expect(answersTo(channel, request.hookId)).toEqual([]);
  });

  test("lets go of the requests of a session that ended", async () => {
    const { asks, channel, emit } = makeHarness(false, { asks: true });
    const request = makeHookPayload("permission-request", bash);
    emit(request);
    emit(makeHookPayload("session-end"));
    await tick();
    expect(asks?.list("ws-test", "tab-test")).toEqual([]);
    expect(answersTo(channel, request.hookId)).toEqual([{ exitCode: 0 }]);
  });
});
