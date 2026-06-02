import { z } from "zod";

export const SshErrorCodeSchema = z.enum([
  "ssh.connect-failed",
  "ssh.auth-failed",
  "ssh.auth-cancelled",
  "ssh.session-expired",
  "ssh.path-not-found",
  "server.spawn-failed",
  "server.protocol-error",
  "server.protocol-version-mismatch",
  "ssh.unknown",
  "transport.unknown",
]);

export type SshErrorCode = z.infer<typeof SshErrorCodeSchema>;
