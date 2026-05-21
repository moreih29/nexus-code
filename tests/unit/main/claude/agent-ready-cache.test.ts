/**
 * AgentReadyCache 단위 테스트.
 *
 * - handleReadyEvent: 유효한 payload 수신 시 캐시 저장.
 * - getHookInfo: 저장된 항목 반환, 없으면 undefined.
 * - delete: 항목 제거 후 getHookInfo가 undefined 반환.
 * - 유효하지 않은 payload 무시.
 */

import { describe, expect, test } from "bun:test";
import { AgentReadyCache } from "../../../../src/main/features/claude/agent-ready-cache";

describe("AgentReadyCache", () => {
  test("agent.hookServerReady 수신 시 정확한 entry 추가", () => {
    const cache = new AgentReadyCache();
    cache.handleReadyEvent("ws-1", {
      workspaceId: "ws-1",
      socketPath: "/tmp/nexus-h-abc.sock",
      token: "deadbeef01234567",
    });

    const info = cache.getHookInfo("ws-1");
    expect(info?.socketPath).toBe("/tmp/nexus-h-abc.sock");
    expect(info?.token).toBe("deadbeef01234567");
  });

  test("workspaceId가 payload에 없어도 저장 가능(외부에서 주입)", () => {
    const cache = new AgentReadyCache();
    cache.handleReadyEvent("ws-2", {
      socketPath: "/tmp/nexus-h-xyz.sock",
      token: "token-xyz",
    });

    const info = cache.getHookInfo("ws-2");
    expect(info?.socketPath).toBe("/tmp/nexus-h-xyz.sock");
  });

  test("없는 workspaceId는 undefined 반환", () => {
    const cache = new AgentReadyCache();
    expect(cache.getHookInfo("no-such-ws")).toBeUndefined();
  });

  test("delete 후 getHookInfo가 undefined 반환", () => {
    const cache = new AgentReadyCache();
    cache.handleReadyEvent("ws-1", {
      socketPath: "/tmp/nexus-h-abc.sock",
      token: "token-abc",
    });
    cache.delete("ws-1");
    expect(cache.getHookInfo("ws-1")).toBeUndefined();
  });

  test("socketPath 없는 payload는 무시", () => {
    const cache = new AgentReadyCache();
    cache.handleReadyEvent("ws-1", { token: "token-only" });
    expect(cache.getHookInfo("ws-1")).toBeUndefined();
  });

  test("token 없는 payload는 무시", () => {
    const cache = new AgentReadyCache();
    cache.handleReadyEvent("ws-1", { socketPath: "/tmp/sock" });
    expect(cache.getHookInfo("ws-1")).toBeUndefined();
  });

  test("null payload는 무시", () => {
    const cache = new AgentReadyCache();
    cache.handleReadyEvent("ws-1", null);
    expect(cache.getHookInfo("ws-1")).toBeUndefined();
  });
});
