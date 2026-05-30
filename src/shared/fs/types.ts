import { z } from "zod";
import { WorkspaceIdSchema } from "../types/workspace-id";

export const FsEntryTypeSchema = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryTypeSchema>;

export const FsChangeKindSchema = z.enum(["added", "modified", "deleted"]);
export type FsChangeKind = z.infer<typeof FsChangeKindSchema>;

export const DirEntrySchema = z.object({
  name: z.string(),
  type: FsEntryTypeSchema,
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const FsStatSchema = z.object({
  type: FsEntryTypeSchema,
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  isSymlink: z.boolean(),
});
export type FsStat = z.infer<typeof FsStatSchema>;

export const FsChangeSchema = z.object({
  relPath: z.string(),
  kind: FsChangeKindSchema,
});
export type FsChange = z.infer<typeof FsChangeSchema>;

export const FsChangedEventSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  changes: z.array(FsChangeSchema),
});
export type FsChangedEvent = z.infer<typeof FsChangedEventSchema>;

export const FileContentSchema = z.object({
  content: z.string(),
  encoding: z.enum(["utf8", "utf8-bom"]),
  sizeBytes: z.number().int().min(0),
  isBinary: z.boolean(),
  mtime: z.string(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

// Writer-side state used by atomic write to detect external modifications
// since the renderer last observed the file. `exists:false` is the
// "first save of a new file" case.
export const ExpectedFileStateSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), mtime: z.string(), size: z.number().int().nonnegative() }),
]);
export type ExpectedFileStateContract = z.infer<typeof ExpectedFileStateSchema>;

export const WriteFileResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    mtime: z.string(),
    size: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("conflict"),
    actual: ExpectedFileStateSchema,
  }),
]);
export type WriteFileResult = z.infer<typeof WriteFileResultSchema>;

// Discriminated-union result for all read IPC calls (git.getFileContent,
// fs.readFile, fs.readExternal). The "missing" variant lets handlers resolve
// instead of throw for domain-normal "not found" cases, eliminating the
// Electron ipcMain stderr noise that results from throw paths.
export const FileReadResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    content: z.string(),
    encoding: z.enum(["utf8", "utf8-bom"]),
    sizeBytes: z.number().int().min(0),
    isBinary: z.boolean(),
    mtime: z.string(),
  }),
  z.object({
    kind: z.literal("missing"),
    reason: z.enum(["ref", "path", "index", "not-found"]),
  }),
]);
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

// Result for fs.readBinary. Companion to FileReadResultSchema for the
// binary-bytes path: where FileReadResult ships text content as a UTF-8
// string, this one ships an arbitrary byte sequence as base64 so JSON
// transport is lossless. Used by the nexus-workspace:// custom protocol
// to serve images from SSH workspaces.
export const FileReadBinaryResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    base64: z.string(),
    sizeBytes: z.number().int().min(0),
    mtime: z.string(),
  }),
  z.object({
    kind: z.literal("missing"),
    reason: z.enum(["not-found"]),
  }),
]);
export type FileReadBinaryResult = z.infer<typeof FileReadBinaryResultSchema>;
