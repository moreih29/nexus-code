import { type IpcErrResult, ipcErr } from "../../../shared/ipc/result";
import { type SshErrorCode, SshErrorCodeSchema } from "../../../shared/ssh/errors";
import { messageForSshErrorCode } from "../agent/pipe";

export function sshErrorCode(error: unknown): SshErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return;
  const parsed = SshErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}

function isAuthCancellation(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error.name === "AbortError" || error.name === "AuthCancelledError") return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

export function agentCallError(
  error: unknown,
  kind: "unavailable" | "auth-failed" | "connection-failed" = "unavailable",
): IpcErrResult | undefined {
  const code = sshErrorCode(error);
  if (code === "ssh.auth-cancelled" || isAuthCancellation(error)) {
    return ipcErr("cancelled", "Operation cancelled", {
      category: "cancelled",
      ...(code ? { domain: "ssh", code } : {}),
    });
  }
  if (code) {
    return ipcErr(
      code === "ssh.session-expired" ? "session-expired" : kind,
      messageForSshErrorCode(code),
      { category: "failed", domain: "ssh", code },
    );
  }
  if (
    error instanceof Error &&
    error.name === "AgentReconnectError" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return ipcErr("unavailable", error.message, { category: "failed", code: error.code });
  }
}
