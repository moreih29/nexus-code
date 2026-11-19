import { randomUUID } from "node:crypto";
import {
  AgentSearchCompleteSchema,
  AgentSearchProgressPayloadSchema,
  SEARCH_CANCEL_METHOD,
  SEARCH_PROGRESS_EVENT,
  SEARCH_TEXT_METHOD,
} from "../../../shared/search/protocol";
import type { FileMatch, TextSearchQuery } from "../../../shared/search/types";
import type { AgentCallOptions } from "../../infra/agent/channel";
import type { AgentBackedProvider } from "../fs/bridge/provider";

/** Owns the ID, progress listener and cancellation for one agent text search. */
export function createAgentSearchSession(
  provider: AgentBackedProvider,
  onBatch: (batch: FileMatch[]) => void,
) {
  const searchId = randomUUID();
  let started = false;
  let answered = false;
  let cancelSent = false;
  const unsubscribe = provider.onAgentEvent(SEARCH_PROGRESS_EVENT, (payload) => {
    const parsed = AgentSearchProgressPayloadSchema.safeParse(payload);
    if (parsed.success && parsed.data.searchId === searchId) onBatch(parsed.data.batch);
  });

  /** Cancels a search that still owns work on the agent. */
  function cancel(): void {
    if (!started || answered || cancelSent) return;
    cancelSent = true;
    void provider.callAgentMethod(SEARCH_CANCEL_METHOD, { searchId }).catch(() => {});
  }

  return {
    /** Sends the search after its progress listener is ready. */
    start(query: TextSearchQuery, options?: AgentCallOptions) {
      started = true;
      const params = { searchId, query };
      const complete = options
        ? provider.callAgentMethod(SEARCH_TEXT_METHOD, params, options)
        : provider.callAgentMethod(SEARCH_TEXT_METHOD, params);
      return complete.then((result) => {
        answered = true;
        return AgentSearchCompleteSchema.parse(result);
      });
    },
    cancel,
    /** Leaves the progress stream and releases any unfinished agent work. */
    dispose(): void {
      unsubscribe();
      cancel();
    },
  };
}
