import { z } from "zod";
import {
  IntegerSchema,
  NonnegativeIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { WorkspaceIdSchema } from "../types/workspace-id";

export const FsEntryTypeSchema = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryTypeSchema>;

export const FsChangeKindSchema = z.enum(["added", "modified", "deleted"]);
export type FsChangeKind = z.infer<typeof FsChangeKindSchema>;

export const DirEntrySchema = z.object({
  name: z.string(),
  type: FsEntryTypeSchema,
  size: NonnegativeIntegerSchema.optional(),
  mtime: z.string().optional(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const FsStatSchema = z.object({
  type: FsEntryTypeSchema,
  size: NonnegativeIntegerSchema,
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

export const FileEncodingSchema = z.enum(["utf8", "utf8-bom", "bytes"]);

export const FileContentSchema = z.object({
  content: z.string(),
  encoding: FileEncodingSchema,
  bytes: z.string().optional(),
  sizeBytes: IntegerSchema.check(z.gte(0)),
  isBinary: z.boolean(),
  mtime: z.string(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const ExpectedFileStateSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), mtime: z.string(), size: NonnegativeIntegerSchema }),
]);
export type ExpectedFileStateContract = z.infer<typeof ExpectedFileStateSchema>;

export const WriteFileResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    mtime: z.string(),
    size: NonnegativeIntegerSchema,
  }),
  z.object({
    kind: z.literal("conflict"),
    actual: ExpectedFileStateSchema,
  }),
]);
export type WriteFileResult = z.infer<typeof WriteFileResultSchema>;

export const FileReadResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    content: z.string(),
    encoding: FileEncodingSchema,
    bytes: z.string().optional(),
    sizeBytes: IntegerSchema.check(z.gte(0)),
    isBinary: z.boolean(),
    mtime: z.string(),
  }),
  z.object({
    kind: z.literal("missing"),
    reason: z.enum(["ref", "path", "index", "not-found"]),
  }),
]);
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

export const FileReadBinaryResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    base64: z.string(),
    sizeBytes: IntegerSchema.check(z.gte(0)),
    mtime: z.string(),
    version: z.string().optional(),
  }),
  z.object({
    kind: z.literal("missing"),
    reason: z.enum(["not-found"]),
  }),
]);
export type FileReadBinaryResult = z.infer<typeof FileReadBinaryResultSchema>;
