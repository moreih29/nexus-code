import { z } from "zod";

export const SshErrorCodeSchema = z.enum([
  "ssh.connect-failed",
  "ssh.auth-failed",
  "agent.spawn-failed",
  "agent.protocol-error",
  "ssh.unknown",
]);

export type SshErrorCode = z.infer<typeof SshErrorCodeSchema>;
