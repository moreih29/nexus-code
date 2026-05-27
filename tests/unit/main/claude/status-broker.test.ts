/**
 * ClaudeStatusBroker 단위 테스트.
 *
 * - set/get/clear/snapshot 동작 검증.
 * - 동일 상태 재설정 시 broadcast 생략(dedupe) 검증.
 * - message 변경만 있어도 broadcast 발사 검증.
 */

import { describe, expect, mock, test } from "bun:test";
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
