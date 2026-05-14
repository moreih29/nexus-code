import type { SshErrorCode } from "../../../shared/types/ssh-errors";
import { classifyStderrLine } from "./ssh-stderr-patterns";

/**
 * Maps one OpenSSH stderr line to a transport error code. Today this delegates
 * to the stderr pattern table; once Phase 1 lands, this module is where the
 * interactive prompt state machine — `password:`, host-key TOFU — will live,
 * paired with a caller-supplied PromptHandler.
 */
export function classifyAuthLine(line: string): SshErrorCode | null {
  return classifyStderrLine(line);
}
