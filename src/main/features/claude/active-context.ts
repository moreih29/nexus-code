// 사용자가 현재 보고 있는 (workspaceId, tabId) 컨텍스트를 main에 캐싱한다.
//
// renderer가 활성 탭을 변경할 때마다 claude.setActiveContext IPC로 push하고,
// main은 Stop hook 처리 시 이 값을 읽어 알림 발사 여부를 결정한다.
//
// 단일 소스 원칙: renderer가 write, main은 read only.

export interface ActiveContext {
  workspaceId: string;
  tabId: string;
}

/**
 * main 프로세스에서 active context를 보관하는 간단한 store.
 *
 * renderer → main 단방향 push 모델이므로 listener / broadcast 기능은 없다.
 * Stop hook 핸들러가 동기적으로 get()을 호출해 비교한다.
 */
export class ActiveContextStore {
  private current: ActiveContext | null = null;

  /** 활성 컨텍스트를 갱신한다. 둘 다 null이면 "활성 없음"으로 설정한다. */
  set(workspaceId: string | null, tabId: string | null): void {
    if (workspaceId === null || tabId === null) {
      this.current = null;
      return;
    }
    this.current = { workspaceId, tabId };
  }

  /** 현재 활성 컨텍스트 또는 null. */
  get(): ActiveContext | null {
    return this.current;
  }

  /**
   * 주어진 (workspaceId, tabId)가 현재 활성인지 확인한다.
   * 활성 컨텍스트가 없으면 항상 false.
   */
  isActive(workspaceId: string, tabId: string): boolean {
    const c = this.current;
    return c !== null && c.workspaceId === workspaceId && c.tabId === tabId;
  }
}
