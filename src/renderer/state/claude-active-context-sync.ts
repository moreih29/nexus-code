// 사용자가 현재 보고 있는 (workspaceId, tabId)를 main에 push한다.
//
// main은 이 컨텍스트를 Stop hook 처리 시 참조해 알림 발사 여부를 결정한다
// (사용자가 그 탭을 보고 있으면 알림 생략). 또한 사용자가 탭을 활성화하면
// markSeen IPC를 통해 completed 상태를 idle로 자동 전이시킨다. 탭을 보고
// 떠난 시각은 session-seen store에 남겨 inbox가 읽음 여부를 판단한다.
//
// 탭을 본다는 것은 앱 창에 포커스가 있다는 뜻이기도 하다 (main의 hook-handler도
// 같은 기준). 다른 앱에 가 있는 동안은 아무 탭도 보고 있지 않고, 돌아오면 그때
// 활성 탭을 다시 보기 시작한다.
//
// active context는 두 store의 조합으로 결정된다:
//  - useActiveStore.activeWorkspaceId : 현재 보고 있는 워크스페이스
//  - useLayoutStore.byWorkspace[ws].activeGroupId → 그 그룹의 leaf.activeTabId
// 에이전트 뷰가 떠 있는 동안은 그 활성 패널 앞의 에이전트가 대신한다.
//
// 둘 중 하나라도 변경되면 새 (workspaceId, tabId)를 계산해 main에 push한다.

import { createLogger } from "../../shared/log/renderer";
import { ipcCallResult } from "../ipc/client";
import { activeKey, parseSessionKey } from "../services/agent-view/layout";
import { useActiveStore } from "./stores/active";
import { useAgentViewStore } from "./stores/agent-view";
import { useAppFocusStore } from "./stores/app-focus";
import { allLeaves } from "./stores/layout/helpers";
import { useLayoutStore } from "./stores/layout/store";
import type { LayoutNode } from "./stores/layout/types";
import { useSessionSeenStore } from "./stores/session-seen";

const log = createLogger("claude-active-context");

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/**
 * 주어진 워크스페이스의 layout에서 현재 active tabId를 계산한다.
 *
 * activeGroupId로 leaf를 찾고 그 leaf의 activeTabId를 반환한다.
 * leaf를 못 찾거나 activeTabId가 null이면 null.
 */
function resolveActiveTabId(root: LayoutNode, activeGroupId: string | null): string | null {
  if (!activeGroupId) return null;
  for (const leaf of allLeaves(root)) {
    if (leaf.id === activeGroupId) {
      return leaf.activeTabId;
    }
  }
  return null;
}

/**
 * 현재 active (workspaceId, tabId) 쌍을 두 store에서 계산한다.
 * workspace 또는 tab이 없으면 둘 다 null로 보고한다.
 */
export function computeActiveContext(): { workspaceId: string | null; tabId: string | null } {
  // 에이전트 뷰가 떠 있으면 활성 패널 앞의 에이전트가 사용자 앞에 있다.
  const agentView = useAgentViewStore.getState();
  if (agentView.mode === "agents") {
    const key = activeKey(agentView);
    const parsed = key !== null ? parseSessionKey(key) : null;
    return parsed ?? { workspaceId: null, tabId: null };
  }

  const workspaceId = useActiveStore.getState().activeWorkspaceId;
  if (!workspaceId) return { workspaceId: null, tabId: null };

  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return { workspaceId, tabId: null };

  const tabId = resolveActiveTabId(layout.root, layout.activeGroupId);
  return { workspaceId, tabId };
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * active store와 layout store 변경을 구독해 main에 setActiveContext IPC를 push한다.
 *
 * bootstrap에서 1회 호출한다. 반환값은 구독 해제 함수.
 *
 * 직전 값과 동일하면 IPC를 발사하지 않아 불필요한 round-trip을 피한다.
 */
export function startClaudeActiveContextSync(): () => void {
  let lastWorkspaceId: string | null = null;
  let lastTabId: string | null = null;
  let initialPushed = false;

  const push = (): void => {
    const { workspaceId, tabId } = computeActiveContext();
    if (initialPushed && workspaceId === lastWorkspaceId && tabId === lastTabId) {
      return;
    }
    // 떠나는 탭은 지금까지, 새로 보는 탭은 지금부터 사용자 앞에 있었다.
    // inbox는 그 전에 끝난 세션을 뺀다 (markSeen이 없는 Codex 등도 같은 기준).
    // 창에 포커스가 없을 때 바뀐 탭(nexus CLI 등)은 아직 아무도 보지 않았다.
    const viewing = useAppFocusStore.getState().focused;
    if (viewing) {
      const seen = useSessionSeenStore.getState();
      if (lastWorkspaceId !== null && lastTabId !== null) seen.markSeen(lastWorkspaceId, lastTabId);
      if (workspaceId !== null && tabId !== null) seen.markSeen(workspaceId, tabId);
    }
    lastWorkspaceId = workspaceId;
    lastTabId = tabId;
    initialPushed = true;
    // fire-and-forget — main 측 실패는 알림 발사 결정에만 영향 (치명적 아님).
    ipcCallResult("claude", "setActiveContext", { workspaceId, tabId }).catch((err: unknown) => {
      log.warn(`setActiveContext IPC failed: ${(err as Error).message}`);
    });

    // 실제 탭이 활성화된 경우, 그 탭의 completed 상태를 자동 해제하기 위해 markSeen.
    // main의 markSeen 핸들러는 completed 상태일 때만 idle로 전이한다 (idempotent).
    if (viewing && workspaceId !== null && tabId !== null) markClaudeSeen(workspaceId, tabId);
  };

  // 창을 떠나고 돌아오는 것도 탭을 바꾸는 것과 같다: 떠날 때까지, 돌아온 뒤부터
  // 활성 탭이 사용자 앞에 있었다. 그 사이에 그 탭에서 끝난 세션만 inbox에 남고,
  // 돌아와 보면 읽은 것이 된다.
  const onFocusChange = (focused: boolean): void => {
    const { workspaceId, tabId } = computeActiveContext();
    if (workspaceId === null || tabId === null) return;
    useSessionSeenStore.getState().markSeen(workspaceId, tabId);
    if (focused) markClaudeSeen(workspaceId, tabId);
  };

  // 초기 1회 push (현재 값 동기화).
  push();

  // 두 store 변경을 모두 구독.
  const unsubActive = useActiveStore.subscribe(push);
  const unsubLayout = useLayoutStore.subscribe(push);
  const unsubAgentView = useAgentViewStore.subscribe(push);
  const unsubFocus = useAppFocusStore.subscribe((state, prev) => {
    if (state.focused !== prev.focused) onFocusChange(state.focused);
  });

  return () => {
    unsubActive();
    unsubLayout();
    unsubAgentView();
    unsubFocus();
  };
}

function markClaudeSeen(workspaceId: string, tabId: string): void {
  ipcCallResult("claude", "markSeen", { workspaceId, tabId }).catch((err: unknown) => {
    log.warn(`markSeen IPC failed: ${(err as Error).message}`);
  });
}
