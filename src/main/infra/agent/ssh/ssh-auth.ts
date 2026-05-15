import type { SshErrorCode } from "../../../../shared/types/ssh-errors";
import { classifyStderrLine } from "./ssh-stderr-patterns";

/**
 * Maps one OpenSSH stderr line to a transport error code by delegating to
 * the stderr pattern table. The interactive prompt state machine
 * (`password:`, host-key TOFU) lives in `ssh-auth-pty`.
 */
export function classifyAuthLine(line: string): SshErrorCode | null {
  return classifyStderrLine(line);
}
