import { z } from "zod";
import { SearchCompleteSchema, SearchProgressSchema, TextSearchQuerySchema } from "./types";

export const SEARCH_TEXT_METHOD = "search.text";
export const SEARCH_CANCEL_METHOD = "search.cancel";
export const SEARCH_PROGRESS_EVENT = "search.progress";

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
