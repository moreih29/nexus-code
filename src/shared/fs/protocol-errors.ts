import { z } from "zod";

export const AgentFsErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "ALREADY_EXISTS",
  "IS_DIRECTORY",
  "NOT_DIRECTORY",
  "TOO_LARGE",
  "TRANSFER_TOO_LARGE",
  "OUT_OF_WORKSPACE",
  "STALE",
  "NOT_EMPTY",
  "CROSS_DEVICE",
  "NO_SPACE",
]);
export type AgentFsErrorCode = z.infer<typeof AgentFsErrorCodeSchema>;
