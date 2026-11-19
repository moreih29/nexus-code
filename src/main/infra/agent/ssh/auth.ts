import type { SshErrorCode } from "../../../../shared/ssh/errors";
import { classifyStderrLine } from "./stderr-patterns";

/**
 * Maps one OpenSSH stderr line to a transport error code by delegating to
 * the stderr pattern table. The interactive prompt state machine
 * (`password:`, host-key TOFU) lives in `ssh-auth-pty`.
 */
export function classifyAuthLine(line: string): SshErrorCode | null {
  return classifyStderrLine(line);
}

/** Error raised when the renderer cancels an active SSH authentication prompt. */
export class AuthCancelledError extends Error {
  constructor(promptId: string) {
    super(`SSH authentication prompt cancelled: ${promptId}`);
    this.name = "AuthCancelledError";
  }
}
