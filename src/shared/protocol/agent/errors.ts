import { z } from "zod";

/**
 * Error codes used inside the NDJSON error frame for fs.* methods.
 *
 * Names follow the existing IPC FS_ERROR convention (UPPER_SNAKE_CASE)
 * so the renderer's toast-mapping logic keeps working when fs handlers
 * are eventually rerouted through the agent. New codes added for
 * write operations:
 *   STALE        — fs.writeFile's `expected` state diverged from disk
 *   NOT_EMPTY    — fs.rmdir refused because the directory is non-empty
 *   CROSS_DEVICE — fs.rename across filesystems (EXDEV)
 *   NO_SPACE     — write failed because the volume is full (ENOSPC)
 *
 * The Go mirror lives in `internal/fs/errors.go`. Drift is caught by
 * round-trip integration tests rather than a static comparator.
 */
export const AgentFsErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "ALREADY_EXISTS",
  "IS_DIRECTORY",
  "TOO_LARGE",
  "OUT_OF_WORKSPACE",
  "STALE",
  "NOT_EMPTY",
  "CROSS_DEVICE",
  "NO_SPACE",
]);
export type AgentFsErrorCode = z.infer<typeof AgentFsErrorCodeSchema>;
