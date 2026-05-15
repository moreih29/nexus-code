import { z } from "zod";
import { MAX_SEARCHABLE_FILE_SIZE } from "../fs/defaults";

export const TextSearchQuerySchema = z.object({
  pattern: z.string().min(1),
  isRegExp: z.boolean().default(false),
  isCaseSensitive: z.boolean().default(false),
  isWordMatch: z.boolean().default(false),
  includes: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
  maxResults: z.number().int().positive().max(20000).default(2000),
  maxFileSize: z.number().int().positive().default(MAX_SEARCHABLE_FILE_SIZE),
});
export type TextSearchQuery = z.infer<typeof TextSearchQuerySchema>;

export const SearchRangeSchema = z.object({
  line: z.number().int().nonnegative(),
  startCol: z.number().int().nonnegative(),
  endCol: z.number().int().nonnegative(),
});
export type SearchRange = z.infer<typeof SearchRangeSchema>;

export const FileMatchSchema = z.object({
  relPath: z.string(),
  matches: z.array(z.object({ range: SearchRangeSchema, preview: z.string() })),
});
export type FileMatch = z.infer<typeof FileMatchSchema>;

export const SearchProgressSchema = z.array(FileMatchSchema);
export type SearchProgress = z.infer<typeof SearchProgressSchema>;

export const SearchCompleteSchema = z.object({
  filesScanned: z.number().int().nonnegative(),
  matchesFound: z.number().int().nonnegative(),
  limitHit: z.boolean(),
  elapsedMs: z.number().nonnegative(),
});
export type SearchComplete = z.infer<typeof SearchCompleteSchema>;
