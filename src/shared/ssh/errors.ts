import { z } from "zod";

export const SshErrorCodeSchema = z.enum([
  "ssh.connect-failed",
  "ssh.auth-failed",
  "ssh.session-expired",
  "server.spawn-failed",
  "server.protocol-error",
  "server.protocol-version-mismatch",
  "ssh.unknown",
  "transport.unknown",
]);

export type SshErrorCode = z.infer<typeof SshErrorCodeSchema>;
