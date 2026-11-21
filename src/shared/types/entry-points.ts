import { z } from "zod";
import {
  IntegerSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";

// ---------------------------------------------------------------------------
// Folder bookmark — discriminated union: local path vs SSH remote path.
// The `kind` field is the discriminant; ssh variant requires connectionProfileId
// to link back to the corresponding connection_profiles row.
// ---------------------------------------------------------------------------

const FolderBookmarkBaseSchema = z.object({
  id: z.guid(),
  absPath: z.string().min(1),
  label: z.string().nullable(),
  favorite: z.boolean(),
  lastUsedAt: IntegerSchema,
  createdAt: IntegerSchema,
});

export const LocalFolderBookmarkSchema = FolderBookmarkBaseSchema.extend({
  kind: z.literal("local"),
});

export const SshFolderBookmarkSchema = FolderBookmarkBaseSchema.extend({
  kind: z.literal("ssh"),
  /** UUID of the associated connection_profiles row. */
  connectionProfileId: z.guid(),
});

export const FolderBookmarkSchema = z.discriminatedUnion("kind", [
  LocalFolderBookmarkSchema,
  SshFolderBookmarkSchema,
]);

export type FolderBookmark = z.infer<typeof FolderBookmarkSchema>;

// ---------------------------------------------------------------------------
// Connection profile
// ---------------------------------------------------------------------------

export const ConnectionProfileSchema = z.object({
  id: z.guid(),
  label: z.string().nullable(),
  host: z.string().min(1),
  /** Normalized: never null/undefined — defaults to the resolved login at write time. */
  user: z.string().min(1),
  /** Normalized: never null/undefined — defaults to 22 at write time. */
  port: PositiveIntegerSchema.check(z.lte(65_535)),
  identityFile: z.string().nullable(),
  authMode: z.string(),
  favorite: z.boolean(),
  lastUsedAt: IntegerSchema,
  createdAt: IntegerSchema,
});

export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

// ---------------------------------------------------------------------------
// Mutation args schemas
// ---------------------------------------------------------------------------

// FolderBookmarkRecordArgsSchema accepts either a local or SSH bookmark for
// recording. The local variant makes `kind` optional (no value required) so
// callers that omit kind (existing LocalListView record calls) continue to
// work at both compile time and runtime without any change at the call site.
// The storage layer treats absent/undefined kind as "local".
export const FolderBookmarkRecordArgsSchema = z.union([
  z.object({
    id: z.guid(),
    absPath: z.string().min(1),
    label: z.string().nullable().optional(),
    kind: z.literal("local").optional(),
    connectionProfileId: z.undefined().optional(),
  }),
  z.object({
    id: z.guid(),
    absPath: z.string().min(1),
    label: z.string().nullable().optional(),
    kind: z.literal("ssh"),
    connectionProfileId: z.guid(),
  }),
]);

export type FolderBookmarkRecordArgs = z.infer<typeof FolderBookmarkRecordArgsSchema>;

export const FolderBookmarkFavoriteArgsSchema = z.object({
  id: z.guid(),
  favorite: z.boolean(),
});

export type FolderBookmarkFavoriteArgs = z.infer<typeof FolderBookmarkFavoriteArgsSchema>;

export const FolderBookmarkIdArgsSchema = z.object({ id: z.guid() });

export type FolderBookmarkIdArgs = z.infer<typeof FolderBookmarkIdArgsSchema>;

// Connection profile save/record args — connection definition only (no remotePath).
// Mirrors WorkspaceTestSshArgsSchema's connection fields.
export const ConnectionProfileSaveArgsSchema = z.object({
  id: z.guid(),
  label: z.string().nullable().optional(),
  host: z.string().min(1),
  user: z.string().min(1),
  port: PositiveIntegerSchema.check(z.lte(65_535)).optional(),
  identityFile: z.string().min(1).optional(),
  authMode: z.enum(["interactive", "key-only"]).default("interactive"),
});

export type ConnectionProfileSaveArgs = z.infer<typeof ConnectionProfileSaveArgsSchema>;

export const ConnectionProfileFavoriteArgsSchema = z.object({
  id: z.guid(),
  favorite: z.boolean(),
});

export type ConnectionProfileFavoriteArgs = z.infer<typeof ConnectionProfileFavoriteArgsSchema>;

export const ConnectionProfileIdArgsSchema = z.object({ id: z.guid() });

export type ConnectionProfileIdArgs = z.infer<typeof ConnectionProfileIdArgsSchema>;
