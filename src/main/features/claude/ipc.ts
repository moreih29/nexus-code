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
 * - call.markSeen: 사용자가 탭을 활성화했음을 통지. completed/needsInput 상태였다면
 *   idle로 전이한다. permissionPending/error는 사용자의 명시적 조치 전까지 보존한다.
 * - call.clearWorkspace: 워크스페이스의 모든 탭 상태를 초기화한다. hook이 stale 상태를
 *   남긴 경우 사용자가 컨텍스트 메뉴에서 수동으로 복구하는 경로.
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
        // 사용자가 탭을 봤다는 사실 자체가 알림 의미를 소실시키는 상태만
        // idle로 전이한다:
        //  - completed: 응답이 끝났음을 알리는 표시 → 봤으면 끝.
        //  - needsInput: Claude가 입력을 기다린다는 알림 → 사용자가 탭을 보고
        //    있으면 곧 입력하거나 닫을 것이므로 글리프는 의미를 잃는다.
        // permissionPending/error/running은 보존 — 사용자의 명시적 조치 또는
        // 시스템 응답 전까지 시각 표시가 유효해야 한다.
        const entry = broker.get(workspaceId, tabId);
        if (entry?.status === "completed" || entry?.status === "needsInput") {
          broker.set(workspaceId, tabId, "idle");
        }
        return ipcOk(undefined);
      },
      clearWorkspace: async (args: unknown) => {
        const { workspaceId } = validateArgs(c.clearWorkspace.args, args);
        broker.clearWorkspace(workspaceId);
        return ipcOk(undefined);
      },
    },
    listen: {
      status: {},
    },
  });
}
