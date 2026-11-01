// The PermissionRequest hook's native fallback.
//
// Claude Code hook spec: "exit 0 + no output = native permission dialog
// fallback". A request the app does not hold for the user (a `claude -p`
// run's, or one of a turn already over) gets it at once; a held one gets it
// once its dialog closes or its hold ends (permission-asks.ts).

import type { HookResponse } from "../../../shared/claude/status";

export interface HandlePermissionRequestOptions {
  /** true이면 OS 알림 발사(notification hook과 공통 헬퍼 사용). 현재 미사용 placeholder. */
  notify?: boolean;
}

/**
 * The fallback answer: no output, exit 0, so Claude Code decides as it would
 * with no hook (its dialog, or a `claude -p` run's denial).
 *
 * @returns HookResponse — stdout 없음, exitCode 0.
 */
export function handlePermissionRequest(
  _options: HandlePermissionRequestOptions = {},
): HookResponse {
  return { exitCode: 0 };
}
