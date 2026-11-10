/**
 * ClaudeStatusBroker 단위 테스트.
 *
 * - set/get/clear/snapshot 동작 검증.
 * - 동일 상태 재설정 시 broadcast 생략(dedupe) 검증.
 * - message 변경만 있어도 broadcast 발사 검증.
 */

import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { ClaudeStatusBroker } from "../../../../src/main/features/claude/status";

function makeBroker() {
  const calls: Array<{ channel: string; event: string; args: unknown }> = [];
  const broadcastFn = mock((channel: string, event: string, args: unknown) => {
    calls.push({ channel, event, args });
  });
  const broker = new ClaudeStatusBroker(broadcastFn);
  return { broker, calls, broadcastFn };
}

describe("ClaudeStatusBroker — broadcast 동작", () => {
  test("동일 상태 재설정 시 broadcast 생략(dedupe)", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-1", "running"); // 동일 — broadcast 없어야 함.
    expect(calls).toHaveLength(1);
  });

  test("상태 변경 시 broadcast 재발사", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-1", "idle");
    expect(calls).toHaveLength(2);
    expect((calls[1].args as { status: string }).status).toBe("idle");
  });

  test("message만 변경돼도 broadcast 재발사", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "needsInput", "first message");
    broker.set("ws-1", "tab-1", "needsInput", "second message");
    expect(calls).toHaveLength(2);
    expect((calls[1].args as { message: string }).message).toBe("second message");
  });

  test("clear 시 cleared 이벤트 broadcast — renderer가 stale 상태를 정리하도록", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    const setCalls = calls.length;
    broker.clear("ws-1", "tab-1");
    expect(calls).toHaveLength(setCalls + 1);
    const evt = calls[setCalls];
    expect(evt.channel).toBe("claude");
    expect(evt.event).toBe("cleared");
    expect(evt.args).toEqual({ workspaceId: "ws-1", tabId: "tab-1" });
  });
});

describe("ClaudeStatusBroker — prompt", () => {
  test("prompt는 다음 set까지 유지 — 상태가 바뀌어도 마지막 지시를 보여주도록", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running", undefined, "fix the build");
    broker.set("ws-1", "tab-1", "completed", "done");
    expect(broker.get("ws-1", "tab-1")?.prompt).toBe("fix the build");
    expect((calls[1].args as { prompt?: string }).prompt).toBe("fix the build");
    expect(broker.snapshot()[0].prompt).toBe("fix the build");
  });

  test("null이면 prompt를 비움 (새 세션)", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "running", undefined, "old");
    broker.set("ws-1", "tab-1", "idle", undefined, null);
    expect(broker.get("ws-1", "tab-1")?.prompt).toBeUndefined();
  });

  test("prompt만 바뀌어도 broadcast 재발사", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running", undefined, "first");
    broker.set("ws-1", "tab-1", "running", undefined, "second");
    expect(calls).toHaveLength(2);
    expect((calls[1].args as { prompt?: string }).prompt).toBe("second");
  });
});

describe("ClaudeStatusBroker — answer", () => {
  test("the answer stays once seen, and through a turn Claude Code starts itself", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running", undefined, "build it");
    broker.set("ws-1", "tab-1", "completed", "Built in 3s.");
    broker.set("ws-1", "tab-1", "idle"); // seen
    expect(broker.get("ws-1", "tab-1")?.message).toBe("Built in 3s.");
    expect((calls.at(-1)?.args as { message?: string }).message).toBe("Built in 3s.");
    broker.set("ws-1", "tab-1", "running"); // a background task's notification
    expect(broker.get("ws-1", "tab-1")?.message).toBe("Built in 3s.");
    expect(broker.get("ws-1", "tab-1")?.prompt).toBe("build it");
  });

  test("the user's next prompt has no answer yet, even when the turn is interrupted", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "completed", "Built in 3s.");
    broker.set("ws-1", "tab-1", "running", undefined, "now test it");
    expect(broker.get("ws-1", "tab-1")?.message).toBeUndefined();
    broker.set("ws-1", "tab-1", "idle"); // interrupted
    expect(broker.snapshot()[0].message).toBeUndefined();
  });

  test("the next turn's answer replaces it, and a turn with none clears it", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "completed", "first");
    broker.set("ws-1", "tab-1", "idle", "second");
    expect(broker.get("ws-1", "tab-1")?.message).toBe("second");
    broker.set("ws-1", "tab-1", "completed", "");
    expect(broker.get("ws-1", "tab-1")?.message).toBeUndefined();
  });

  test("a question or permission shows while it waits, then the answer comes back", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "completed", "Built.");
    broker.set("ws-1", "tab-1", "permissionPending", "Claude needs permission: Bash");
    expect(broker.get("ws-1", "tab-1")?.message).toBe("Claude needs permission: Bash");
    broker.set("ws-1", "tab-1", "running");
    expect(broker.get("ws-1", "tab-1")?.message).toBe("Built.");
    broker.set("ws-1", "tab-1", "needsInput", "Claude is waiting for your input");
    broker.set("ws-1", "tab-1", "idle"); // seen
    expect(broker.get("ws-1", "tab-1")?.message).toBe("Built.");
  });

  test("a new session has no answer", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "completed", "old answer");
    broker.set("ws-1", "tab-1", "idle", undefined, null);
    expect(broker.get("ws-1", "tab-1")?.message).toBeUndefined();
  });
});

describe("ClaudeStatusBroker — since and turn start", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("since is when the status changed, not the message", () => {
    const { broker } = makeBroker();
    setSystemTime(new Date(1_000_000));
    broker.set("ws-1", "tab-1", "needsInput", "Which DB?");
    setSystemTime(new Date(1_005_000));
    broker.set("ws-1", "tab-1", "needsInput", "Which DB, Postgres or SQLite?");
    expect(broker.get("ws-1", "tab-1")?.since).toBe(1_000_000);
    broker.set("ws-1", "tab-1", "idle");
    expect(broker.get("ws-1", "tab-1")?.since).toBe(1_005_000);
  });

  test("a turn starts on going to running or on a prompt, not on each tool", () => {
    const { broker } = makeBroker();
    setSystemTime(new Date(2_000_000));
    broker.set("ws-1", "tab-1", "idle");
    expect(broker.get("ws-1", "tab-1")?.turnStartedAt).toBeUndefined();
    setSystemTime(new Date(2_001_000));
    broker.set("ws-1", "tab-1", "running", undefined, "add a test");
    setSystemTime(new Date(2_002_000));
    broker.set("ws-1", "tab-1", "running");
    expect(broker.get("ws-1", "tab-1")?.turnStartedAt).toBe(2_001_000);
    setSystemTime(new Date(2_003_000));
    broker.set("ws-1", "tab-1", "running", undefined, "and run it");
    expect(broker.get("ws-1", "tab-1")?.turnStartedAt).toBe(2_003_000);
    setSystemTime(new Date(2_004_000));
    broker.set("ws-1", "tab-1", "completed", "Done.");
    broker.set("ws-1", "tab-1", "idle");
    expect(broker.get("ws-1", "tab-1")?.turnStartedAt).toBe(2_003_000);
  });
});
