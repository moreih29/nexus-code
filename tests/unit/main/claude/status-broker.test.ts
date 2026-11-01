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

describe("ClaudeStatusBroker — 기본 동작", () => {
  test("set 후 get으로 상태 조회", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    const entry = broker.get("ws-1", "tab-1");
    expect(entry?.status).toBe("running");
    expect(entry?.message).toBeUndefined();
    expect(typeof entry?.since).toBe("number");
  });

  test("set 후 clear하면 get이 null 반환", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    broker.clear("ws-1", "tab-1");
    expect(broker.get("ws-1", "tab-1")).toBeNull();
  });

  test("없는 키는 get이 null 반환", () => {
    const { broker } = makeBroker();
    expect(broker.get("ws-x", "tab-x")).toBeNull();
  });

  test("message 포함 set", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "needsInput", "Needs attention");
    const entry = broker.get("ws-1", "tab-1");
    expect(entry?.status).toBe("needsInput");
    expect(entry?.message).toBe("Needs attention");
  });

  test("snapshot — 여러 항목 반환", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-2", "idle");
    broker.set("ws-2", "tab-1", "needsInput", "msg");

    const snap = broker.snapshot();
    expect(snap).toHaveLength(3);

    const ws1t1 = snap.find((e) => e.workspaceId === "ws-1" && e.tabId === "tab-1");
    expect(ws1t1?.status).toBe("running");

    const ws2t1 = snap.find((e) => e.workspaceId === "ws-2" && e.tabId === "tab-1");
    expect(ws2t1?.message).toBe("msg");
  });

  test("clear 후 snapshot에서 제거", () => {
    const { broker } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-2", "idle");
    broker.clear("ws-1", "tab-1");

    const snap = broker.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].tabId).toBe("tab-2");
  });
});

describe("ClaudeStatusBroker — broadcast 동작", () => {
  test("set 시 broadcast 발사", () => {
    const { broker, calls } = makeBroker();
    broker.set("ws-1", "tab-1", "running");
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("claude");
    expect(calls[0].event).toBe("status");
    const entry = calls[0].args as { workspaceId: string; tabId: string; status: string };
    expect(entry.workspaceId).toBe("ws-1");
    expect(entry.tabId).toBe("tab-1");
    expect(entry.status).toBe("running");
  });

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

  test("since는 broadcast payload에 포함", () => {
    const { broker, calls } = makeBroker();
    const before = Date.now();
    broker.set("ws-1", "tab-1", "running");
    const after = Date.now();
    const entry = calls[0].args as { since: number };
    expect(entry.since).toBeGreaterThanOrEqual(before);
    expect(entry.since).toBeLessThanOrEqual(after);
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

  test("없는 entry를 clear하면 broadcast 생략 (noise 억제)", () => {
    const { broker, calls } = makeBroker();
    broker.clear("ws-x", "tab-x");
    expect(calls).toHaveLength(0);
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

describe("ClaudeStatusBroker — onChange", () => {
  test("set·clear·clearWorkspace 마다 listener를 부르고, 해제하면 멈춘다", () => {
    const { broker } = makeBroker();
    const seen: unknown[] = [];
    const off = broker.onChange((workspaceId, tabId, entry) =>
      seen.push([workspaceId, tabId, entry?.status ?? null]),
    );
    broker.set("ws-1", "tab-1", "running");
    broker.set("ws-1", "tab-1", "running"); // 동일 — 생략
    broker.clear("ws-1", "tab-1");
    broker.set("ws-1", "tab-2", "completed");
    broker.clearWorkspace("ws-1");
    off();
    broker.set("ws-1", "tab-1", "idle");
    expect(seen).toEqual([
      ["ws-1", "tab-1", "running"],
      ["ws-1", "tab-1", null],
      ["ws-1", "tab-2", "completed"],
      ["ws-1", "tab-2", null],
    ]);
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
