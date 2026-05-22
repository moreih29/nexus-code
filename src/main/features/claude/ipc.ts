// Claude IPC 채널 등록 — snapshot/setActiveContext/markSeen call + status listen.
// 기존 pty/ipc.ts의 register 패턴을 그대로 따른다.

import { ipcContract } from "../../../shared/ipc/contract";
import { register, validateArgs } from "../../infra/ipc-router";
import { ipcOk } from "../../../shared/ipc/result";
import type { ClaudeStatusBroker } from "./status";
import type { ActiveContextStore } from "./active-context";

const c = ipcContract.claude.call;

/**
 * claude IPC 채널을 등록한다.
 *
 * - call.snapshot: 현재 모든 (workspaceId, tabId) 상태 반환. renderer 초기화 시 1회 호출.
 * - call.setActiveContext: renderer가 활성 탭 변경 시 push. main이 캐싱해 Stop 알림 결정에 사용.
 * - call.markSeen: 사용자가 탭을 활성화했음을 통지. completed 상태였다면 idle로 전이.
 * - listen.status: 상태 변경 시 broker가 직접 broadcast하므로 여기서는 빈 객체로 선언.
 */
export function registerClaudeChannel(
  broker: ClaudeStatusBroker,
  activeContext: ActiveContextStore,
): void {
  register("claude", {
    call: {
      snapshot: async () => ipcOk(broker.snapshot()),
      setActiveContext: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.setActiveContext.args, args);
        activeContext.set(workspaceId, tabId);
        return ipcOk(undefined);
      },
      markSeen: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.markSeen.args, args);
        // completed 상태인 탭만 idle로 전이. 다른 상태(running/needsInput 등)는 보존한다.
        const entry = broker.get(workspaceId, tabId);
        if (entry?.status === "completed") {
          broker.set(workspaceId, tabId, "idle");
        }
        return ipcOk(undefined);
      },
    },
    listen: {
      status: {},
    },
  });
}
