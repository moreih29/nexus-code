// Claude IPC 채널 등록 — snapshot call + status listen.
// 기존 pty/ipc.ts의 register 패턴을 그대로 따른다.

import { register } from "../../infra/ipc-router";
import { ipcOk } from "../../../shared/ipc/result";
import type { ClaudeStatusBroker } from "./status";

/**
 * claude IPC 채널을 등록한다.
 *
 * - call.snapshot: 현재 모든 (workspaceId, tabId) 상태 반환. renderer 초기화 시 1회 호출.
 * - listen.status: 상태 변경 시 broker가 직접 broadcast하므로 여기서는 빈 객체로 선언.
 */
export function registerClaudeChannel(broker: ClaudeStatusBroker): void {
  register("claude", {
    call: {
      snapshot: async () => ipcOk(broker.snapshot()),
    },
    listen: {
      status: {},
    },
  });
}
