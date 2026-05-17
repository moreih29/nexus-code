import { z } from "zod";

// ---------------------------------------------------------------------------
// Folder bookmark
// ---------------------------------------------------------------------------

export const FolderBookmarkSchema = z.object({
  id: z.string().uuid(),
  absPath: z.string().min(1),
  label: z.string().nullable(),
  favorite: z.boolean(),
  lastUsedAt: z.number().int(),
  createdAt: z.number().int(),
});

export type FolderBookmark = z.infer<typeof FolderBookmarkSchema>;

// ---------------------------------------------------------------------------
// Connection profile
// ---------------------------------------------------------------------------

export const ConnectionProfileSchema = z.object({
  id: z.string().uuid(),
  label: z.string().nullable(),
  host: z.string().min(1),
  /** Normalized: never null/undefined — defaults to the resolved login at write time. */
  user: z.string().min(1),
  /** Normalized: never null/undefined — defaults to 22 at write time. */
  port: z.number().int().positive().max(65_535),
  identityFile: z.string().nullable(),
  authMode: z.string(),
  favorite: z.boolean(),
  lastUsedAt: z.number().int(),
  createdAt: z.number().int(),
});

export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

// ---------------------------------------------------------------------------
// Mutation args schemas
// ---------------------------------------------------------------------------

export const FolderBookmarkRecordArgsSchema = z.object({
  id: z.string().uuid(),
  absPath: z.string().min(1),
  label: z.string().nullable().optional(),
});

export type FolderBookmarkRecordArgs = z.infer<typeof FolderBookmarkRecordArgsSchema>;

export const FolderBookmarkFavoriteArgsSchema = z.object({
  id: z.string().uuid(),
  favorite: z.boolean(),
});

export type FolderBookmarkFavoriteArgs = z.infer<typeof FolderBookmarkFavoriteArgsSchema>;

export const FolderBookmarkIdArgsSchema = z.object({ id: z.string().uuid() });

export type FolderBookmarkIdArgs = z.infer<typeof FolderBookmarkIdArgsSchema>;

// Connection profile save/record args — connection definition only (no remotePath).
// Mirrors WorkspaceTestSshArgsSchema's connection fields.
export const ConnectionProfileSaveArgsSchema = z.object({
  id: z.string().uuid(),
  label: z.string().nullable().optional(),
  host: z.string().min(1),
  user: z.string().min(1),
  port: z.number().int().positive().max(65_535).optional(),
  identityFile: z.string().min(1).optional(),
  authMode: z.enum(["interactive", "key-only"]).default("interactive"),
});

export type ConnectionProfileSaveArgs = z.infer<typeof ConnectionProfileSaveArgsSchema>;

export const ConnectionProfileFavoriteArgsSchema = z.object({
  id: z.string().uuid(),
  favorite: z.boolean(),
});

export type ConnectionProfileFavoriteArgs = z.infer<typeof ConnectionProfileFavoriteArgsSchema>;

export const ConnectionProfileIdArgsSchema = z.object({ id: z.string().uuid() });

export type ConnectionProfileIdArgs = z.infer<typeof ConnectionProfileIdArgsSchema>;
