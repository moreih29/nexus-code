import { z } from "zod";
import {
  ExpectedFileStateSchema,
  FileReadResultSchema,
  WriteFileResultSchema,
} from "./types";

/**
 * NDJSON method signatures for fs.* operations on the agent.
 *
 * The Electron main process binds one agent child per workspace, so workspace
 * identity is NOT part of any params here — the server's working root is fixed
 * at process start.
 */

/** Workspace-relative path. Empty strings are rejected. */
const RelPathSchema = z.string().min(1);

/** Agent-host absolute path used for read-only external references. */
const AbsolutePathSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// fs.readAbsolute — read an absolute path on the agent host.
// Used for LSP/external references outside the workspace root.
// ---------------------------------------------------------------------------

export const FS_READ_ABSOLUTE_METHOD = "fs.readAbsolute" as const;

export const FsReadAbsoluteParamsSchema = z.object({ absolutePath: AbsolutePathSchema });
export type FsReadAbsoluteParams = z.infer<typeof FsReadAbsoluteParamsSchema>;

export const FsReadAbsoluteResultSchema = FileReadResultSchema;
export type FsReadAbsoluteResult = z.infer<typeof FsReadAbsoluteResultSchema>;

// ---------------------------------------------------------------------------
// fs.writeFile — atomic overwrite with optional optimistic-concurrency check.
// ---------------------------------------------------------------------------

export const FS_WRITE_FILE_METHOD = "fs.writeFile" as const;

/**
 * `expected` carries the file state the writer last observed. When the
 * actual state diverges, the server returns `{ kind: "conflict", actual }`
 * instead of overwriting.
 */
export const FsWriteFileParamsSchema = z.object({
  relPath: RelPathSchema,
  content: z.string(),
  expected: ExpectedFileStateSchema.optional(),
});
export type FsWriteFileParams = z.infer<typeof FsWriteFileParamsSchema>;

export const FsWriteFileResultSchema = WriteFileResultSchema;
export type FsWriteFileResult = z.infer<typeof FsWriteFileResultSchema>;

// ---------------------------------------------------------------------------
// fs.createFile — create empty file with O_EXCL semantics.
// Fails with ALREADY_EXISTS when the path is taken; the renderer relies
// on that to avoid silently overwriting hidden/filtered-out files.
// ---------------------------------------------------------------------------

export const FS_CREATE_FILE_METHOD = "fs.createFile" as const;

export const FsCreateFileParamsSchema = z.object({ relPath: RelPathSchema });
export type FsCreateFileParams = z.infer<typeof FsCreateFileParamsSchema>;

// ---------------------------------------------------------------------------
// fs.mkdir — create a directory. Recursive is opt-in; when false (default),
// a missing parent surfaces as NOT_FOUND so the renderer can surface the
// real problem instead of silently materializing several segments.
// ---------------------------------------------------------------------------

export const FS_MKDIR_METHOD = "fs.mkdir" as const;

export const FsMkdirParamsSchema = z.object({
  relPath: RelPathSchema,
  recursive: z.boolean().optional(),
});
export type FsMkdirParams = z.infer<typeof FsMkdirParamsSchema>;

// ---------------------------------------------------------------------------
// fs.unlink — remove a file or symlink. Directories are refused with
// IS_DIRECTORY so callers explicitly choose rmdir for empty dirs or a
// higher-level recursive-delete flow.
// ---------------------------------------------------------------------------

export const FS_UNLINK_METHOD = "fs.unlink" as const;

export const FsUnlinkParamsSchema = z.object({ relPath: RelPathSchema });
export type FsUnlinkParams = z.infer<typeof FsUnlinkParamsSchema>;

// ---------------------------------------------------------------------------
// fs.rmdir — remove an empty directory. Non-empty dirs fail with NOT_EMPTY
// so the renderer can confirm before any destructive recursive operation.
// ---------------------------------------------------------------------------

export const FS_RMDIR_METHOD = "fs.rmdir" as const;

export const FsRmdirParamsSchema = z.object({ relPath: RelPathSchema });
export type FsRmdirParams = z.infer<typeof FsRmdirParamsSchema>;

// ---------------------------------------------------------------------------
// fs.rename — move/rename within the bound workspace. Cross-workspace
// moves are not supported here; the channel is per-workspace, and any
// cross-workspace flow belongs to higher-level orchestration.
// ---------------------------------------------------------------------------

export const FS_RENAME_METHOD = "fs.rename" as const;

export const FsRenameParamsSchema = z.object({
  fromRelPath: RelPathSchema,
  toRelPath: RelPathSchema,
});
export type FsRenameParams = z.infer<typeof FsRenameParamsSchema>;

// ---------------------------------------------------------------------------
// fs.copyFile — copy a file within the bound workspace. Both paths must
// be workspace-relative. Fails if the destination already exists — the
// renderer handles overwrite-confirm flows before calling this.
// ---------------------------------------------------------------------------

export const FS_COPY_FILE_METHOD = "fs.copyFile" as const;

export const FsCopyFileParamsSchema = z.object({
  fromRelPath: RelPathSchema,
  toRelPath: RelPathSchema,
});
export type FsCopyFileParams = z.infer<typeof FsCopyFileParamsSchema>;

// ---------------------------------------------------------------------------
// fs.removeAll — recursively remove a file or directory. Unlike rmdir,
// this does NOT require the target to be empty — it removes everything at
// the given path, including non-empty directories.
// ---------------------------------------------------------------------------

export const FS_REMOVE_ALL_METHOD = "fs.removeAll" as const;

export const FsRemoveAllParamsSchema = z.object({ relPath: RelPathSchema });
export type FsRemoveAllParams = z.infer<typeof FsRemoveAllParamsSchema>;
