import { z } from "zod";
import {
  IntegerSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";

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
  connectionProfileId: z.guid(),
});

export const FolderBookmarkSchema = z.discriminatedUnion("kind", [
  LocalFolderBookmarkSchema,
  SshFolderBookmarkSchema,
]);

export type FolderBookmark = z.infer<typeof FolderBookmarkSchema>;

export const ConnectionProfileSchema = z.object({
  id: z.guid(),
  label: z.string().nullable(),
  host: z.string().min(1),
  user: z.string().min(1),
  port: PositiveIntegerSchema.check(z.lte(65_535)),
  identityFile: z.string().nullable(),
  authMode: z.string(),
  favorite: z.boolean(),
  lastUsedAt: IntegerSchema,
  createdAt: IntegerSchema,
});

export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

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
