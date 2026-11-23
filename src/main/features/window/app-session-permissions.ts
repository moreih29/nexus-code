import type { Session } from "electron";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("app-session-permissions");

const SUBFRAME_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

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
