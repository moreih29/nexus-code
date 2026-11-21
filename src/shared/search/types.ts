import { z } from "zod";
import {
  NonnegativeIntegerSchema,
  NonnegativeNumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { MAX_SEARCHABLE_FILE_SIZE } from "../fs/defaults";

export const TextSearchQuerySchema = z.object({
  pattern: z.string().min(1),
  isRegExp: z.boolean().default(false),
  isCaseSensitive: z.boolean().default(false),
  isWordMatch: z.boolean().default(false),
  includes: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
  maxResults: PositiveIntegerSchema.check(z.lte(20000)).default(2000),
  maxFileSize: PositiveIntegerSchema.default(MAX_SEARCHABLE_FILE_SIZE),
});
export type TextSearchQuery = z.infer<typeof TextSearchQuerySchema>;

export const SearchRangeSchema = z.object({
  line: NonnegativeIntegerSchema,
  startCol: NonnegativeIntegerSchema,
  endCol: NonnegativeIntegerSchema,
});
export type SearchRange = z.infer<typeof SearchRangeSchema>;

export const FileMatchSchema = z.object({
  relPath: z.string(),
  matches: z.array(
    z.object({
      range: SearchRangeSchema,
      preview: z.string(),
      // Column where `preview` begins when the agent cut a long line down to
      // a window around the match; `range` stays relative to the whole line.
      previewStart: NonnegativeIntegerSchema.optional(),
    }),
  ),
});
export type FileMatch = z.infer<typeof FileMatchSchema>;

export const SearchProgressSchema = z.array(FileMatchSchema);
export type SearchProgress = z.infer<typeof SearchProgressSchema>;

export const SearchCompleteSchema = z.object({
  filesScanned: NonnegativeIntegerSchema,
  matchesFound: NonnegativeIntegerSchema,
  limitHit: z.boolean(),
  elapsedMs: NonnegativeNumberSchema,
});
export type SearchComplete = z.infer<typeof SearchCompleteSchema>;
