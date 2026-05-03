import { z } from "zod";

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
  workspaceId: z.string().uuid(),
  changes: z.array(FsChangeSchema),
});
export type FsChangedEvent = z.infer<typeof FsChangedEventSchema>;

export const FileContentSchema = z.object({
  content: z.string(),
  encoding: z.enum(["utf8", "utf8-bom"]),
  sizeBytes: z.number().int().min(0),
  isBinary: z.boolean(),
});
export type FileContent = z.infer<typeof FileContentSchema>;
