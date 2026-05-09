/** Subscribes to fs.changed events for the entry's file and triggers external-change reconciliation. */

import type { ModelEntry, ModelEntryDeps } from "./model-entry";

export function attachFsSubscription(
  entry: ModelEntry,
  deps: Pick<ModelEntryDeps, "subscribeFsChanged">,
  onChanged: () => void,
): () => void {
  return deps.subscribeFsChanged(entry.input, onChanged);
}
