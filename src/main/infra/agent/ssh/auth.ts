import type { SshErrorCode } from "../../../../shared/ssh/errors";
import { classifyStderrLine } from "./stderr-patterns";

export function classifyAuthLine(line: string): SshErrorCode | null {
  return classifyStderrLine(line);
}

export class AuthCancelledError extends Error {
  constructor(promptId: string) {
    super(`SSH authentication prompt cancelled: ${promptId}`);
    this.name = "AuthCancelledError";
  }
}
