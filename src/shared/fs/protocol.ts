import { z } from "zod";
import {
  IntegerSchema,
  NonnegativeIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import {
  ExpectedFileStateSchema,
  FileReadBinaryResultSchema,
  FileReadResultSchema,
  WriteFileResultSchema,
} from "./types";

const RelPathSchema = z.string().min(1);

const AbsolutePathSchema = z.string().min(1);

export const FS_READ_ABSOLUTE_METHOD = "fs.readAbsolute" as const;

export const FsReadAbsoluteParamsSchema = z.object({ absolutePath: AbsolutePathSchema });
export type FsReadAbsoluteParams = z.infer<typeof FsReadAbsoluteParamsSchema>;

export const FsReadAbsoluteResultSchema = FileReadResultSchema;
export type FsReadAbsoluteResult = z.infer<typeof FsReadAbsoluteResultSchema>;

export const FS_READ_ABSOLUTE_BINARY_METHOD = "fs.readAbsoluteBinary" as const;

export const FS_READ_BINARY_METHOD = "fs.readBinary" as const;

export const FsReadBinaryParamsSchema = z.object({ relPath: RelPathSchema });
export type FsReadBinaryParams = z.infer<typeof FsReadBinaryParamsSchema>;

export const FsReadBinaryResultSchema = FileReadBinaryResultSchema;
export type FsReadBinaryResult = z.infer<typeof FsReadBinaryResultSchema>;

export const FS_READ_RANGE_METHOD = "fs.readRange" as const;
export const FS_READ_ABSOLUTE_RANGE_METHOD = "fs.readAbsoluteRange" as const;

const RangeSchema = {
  offset: IntegerSchema.check(z.gte(0)),
  length: IntegerSchema.check(z.gte(0)),
};

export const FsReadRangeParamsSchema = z.object({ relPath: RelPathSchema, ...RangeSchema });
export type FsReadRangeParams = z.infer<typeof FsReadRangeParamsSchema>;

export const FsReadAbsoluteRangeParamsSchema = z.object({
  absolutePath: AbsolutePathSchema,
  ...RangeSchema,
});
export type FsReadAbsoluteRangeParams = z.infer<typeof FsReadAbsoluteRangeParamsSchema>;

export const FS_READ_PREVIEW_METHOD = "fs.readPreview" as const;

export type FsPreviewPath =
  | { relPath: string }
  | { absolutePath: string; expectedRealPath?: string };

export type FsPreviewParams = FsPreviewPath & {
  offset: number;
  length: number;
  wholeImage?: boolean;
  versionScope?: string;
  ifVersion?: string;
  requireVersion?: string;
};

export const FsPreviewResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    base64: z.string(),
    sizeBytes: NonnegativeIntegerSchema,
    version: z.string().min(1).max(128).optional(),
  }),
  z.object({ kind: z.literal("notModified"), version: z.string().min(1).max(128) }),
]);
export type FsPreviewResult = z.infer<typeof FsPreviewResultSchema>;

export const FS_WRITE_FILE_METHOD = "fs.writeFile" as const;

export const FsWriteFileParamsSchema = z.object({
  relPath: RelPathSchema,
  content: z.string(),
  bytes: z.string().optional(),
  expected: ExpectedFileStateSchema.optional(),
});
export type FsWriteFileParams = z.infer<typeof FsWriteFileParamsSchema>;

export const FsWriteFileResultSchema = WriteFileResultSchema;
export type FsWriteFileResult = z.infer<typeof FsWriteFileResultSchema>;

export const FS_CREATE_FILE_METHOD = "fs.createFile" as const;

export const FsCreateFileParamsSchema = z.object({ relPath: RelPathSchema });
export type FsCreateFileParams = z.infer<typeof FsCreateFileParamsSchema>;

export const FS_MKDIR_METHOD = "fs.mkdir" as const;

export const FsMkdirParamsSchema = z.object({
  relPath: RelPathSchema,
  recursive: z.boolean().optional(),
});
export type FsMkdirParams = z.infer<typeof FsMkdirParamsSchema>;

export const FS_UNLINK_METHOD = "fs.unlink" as const;

export const FsUnlinkParamsSchema = z.object({ relPath: RelPathSchema });
export type FsUnlinkParams = z.infer<typeof FsUnlinkParamsSchema>;

export const FS_RMDIR_METHOD = "fs.rmdir" as const;

export const FsRmdirParamsSchema = z.object({ relPath: RelPathSchema });
export type FsRmdirParams = z.infer<typeof FsRmdirParamsSchema>;

export const FS_RENAME_METHOD = "fs.rename" as const;

export const FsRenameParamsSchema = z.object({
  fromRelPath: RelPathSchema,
  toRelPath: RelPathSchema,
  overwrite: z.boolean().optional(),
});
export type FsRenameParams = z.infer<typeof FsRenameParamsSchema>;

export const FS_COPY_FILE_METHOD = "fs.copyFile" as const;

export const FsCopyFileParamsSchema = z.object({
  fromRelPath: RelPathSchema,
  toRelPath: RelPathSchema,
  overwrite: z.boolean().optional(),
});
export type FsCopyFileParams = z.infer<typeof FsCopyFileParamsSchema>;

export const FS_REMOVE_ALL_METHOD = "fs.removeAll" as const;

export const FsRemoveAllParamsSchema = z.object({ relPath: RelPathSchema });
export type FsRemoveAllParams = z.infer<typeof FsRemoveAllParamsSchema>;
