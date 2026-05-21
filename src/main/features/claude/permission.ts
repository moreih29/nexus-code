// PermissionRequest hook 처리 placeholder.
//
// 1차: 즉시 exit 0 응답(stdout 생략 = native PTY prompt fallback)을 반환한다.
// Claude Code hook spec: "exit 0 + no output = native permission dialog fallback".
//
// TODO(후속 PR): modal UI 호출 — allow/deny 단축키, 도구별 컨텍스트 패널,
//   allow once/always 정책 저장. permission.ts에 handlePermissionRequest()의
//   구체적 UI 연결 로직 추가.

import type { HookResponse } from "../../../shared/claude/status";

export interface HandlePermissionRequestOptions {
  /** true이면 OS 알림 발사(notification hook과 공통 헬퍼 사용). 현재 미사용 placeholder. */
  notify?: boolean;
}

/**
 * PermissionRequest hook 수신 시 호출되는 1차 handler.
 *
 * 1차 구현은 즉시 `{ exitCode: 0 }` 응답을 반환해 Claude Code가
 * native PTY permission prompt로 fallback하도록 한다.
 *
 * @returns HookResponse — stdout 없음, exitCode 0.
 */
export function handlePermissionRequest(
  _options: HandlePermissionRequestOptions = {},
): HookResponse {
  // TODO(후속 PR): modal UI를 열어 사용자 결정을 기다린 뒤 allow/deny를 응답한다.
  return { exitCode: 0 };
}
