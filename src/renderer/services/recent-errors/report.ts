import type { BugReportErrorArea } from "../../../../packages/remote-protocol/src/bug-report";
import { bugReportErrorCode } from "../../../shared/remote/bug-report";
import { ipcCallResult } from "../../ipc/client";

export function reportError(
  area: BugReportErrorArea,
  codeParts: readonly string[],
  status?: number,
  message?: string,
): void {
  const code = bugReportErrorCode(...codeParts);
  if (!code) return;
  try {
    void ipcCallResult("system", "recordError", {
      area,
      code,
      ...(status !== undefined ? { status } : {}),
      ...(message !== undefined ? { message } : {}),
    }).catch(() => {});
  } catch {}
}
