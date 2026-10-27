import type { Session } from "electron";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("app-session-permissions");

/**
 * What a subframe of the app window may use without asking. Subframes are
 * previewed workspace HTML and whatever it embeds or navigates to; copy
 * buttons are the one capability pages use that Chrome also grants silently.
 */
const SUBFRAME_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

/**
 * Permission policy for the app's own session (main windows; embedded
 * browser tabs use their own partitions).
 *
 * Electron grants every permission when no handler is installed. The top
 * frame is the app UI and keeps that. A subframe would otherwise get camera,
 * microphone, geolocation and `openExternal` — the last one lets a previewed
 * page hand smb://, vscode:// or any other URL to the OS handler with no
 * prompt. Preview link clicks already go through the window-open allowlist,
 * so subframes lose nothing they legitimately use.
 */
export function installAppSessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed = details.isMainFrame || SUBFRAME_PERMISSIONS.has(permission);
    if (!allowed) {
      logger.warn(`Denied ${permission} for subframe ${details.requestingUrl}`);
    }
    callback(allowed);
  });
  session.setPermissionCheckHandler(
    (_webContents, permission, _requestingOrigin, details) =>
      details.isMainFrame || SUBFRAME_PERMISSIONS.has(permission),
  );
}
