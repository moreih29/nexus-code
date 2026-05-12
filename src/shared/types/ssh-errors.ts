import { z } from "zod";

export const SshErrorCodeSchema = z.enum([
  "ssh.connect-failed",
  "ssh.auth-failed",
  "server.spawn-failed",
  "server.protocol-error",
  "server.protocol-version-mismatch",
  "ssh.unknown",
]);

export type SshErrorCode = z.infer<typeof SshErrorCodeSchema>;
