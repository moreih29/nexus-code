import type { HookResponse } from "../../../shared/claude/status";

export interface HandlePermissionRequestOptions {
  notify?: boolean;
}

export function handlePermissionRequest(
  _options: HandlePermissionRequestOptions = {},
): HookResponse {
  return { exitCode: 0 };
}
