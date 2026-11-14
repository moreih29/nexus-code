import { z } from "zod";
import { SearchCompleteSchema, SearchProgressSchema, TextSearchQuerySchema } from "./types";

export const SEARCH_TEXT_METHOD = "search.text";
export const SEARCH_CANCEL_METHOD = "search.cancel";
export const SEARCH_PROGRESS_EVENT = "search.progress";
/** Files by name, as quick open finds them; an older agent (on a host not updated yet) lacks it. */
export const SEARCH_FILES_METHOD = "search.files";

export const AgentSearchTextParamsSchema = z.object({
  searchId: z.string().min(1),
  query: TextSearchQuerySchema,
});
export type AgentSearchTextParams = z.infer<typeof AgentSearchTextParamsSchema>;

export const AgentSearchCancelParamsSchema = z.object({
  searchId: z.string().min(1),
});
export type AgentSearchCancelParams = z.infer<typeof AgentSearchCancelParamsSchema>;

export const AgentSearchProgressPayloadSchema = z.object({
  searchId: z.string().min(1),
  batch: SearchProgressSchema,
});
export type AgentSearchProgressPayload = z.infer<typeof AgentSearchProgressPayloadSchema>;

export const AgentSearchCompleteSchema = SearchCompleteSchema;

export const AgentSearchFilesParamsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(1000).optional(),
});
export type AgentSearchFilesParams = z.infer<typeof AgentSearchFilesParamsSchema>;

/** Relative paths with "/" between their parts, the best matches first. */
export const AgentSearchFilesResultSchema = z.object({
  files: z.array(z.string()),
  /** The walk stopped before every file was seen. */
  truncated: z.boolean(),
});
export type AgentSearchFilesResult = z.infer<typeof AgentSearchFilesResultSchema>;
