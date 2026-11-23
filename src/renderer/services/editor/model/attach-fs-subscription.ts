import type { ModelEntry, ModelEntryDeps } from "./types";

export function attachFsSubscription(
  entry: ModelEntry,
  deps: Pick<ModelEntryDeps, "subscribeFsChanged">,
  onChanged: () => void,
): () => void {
  return deps.subscribeFsChanged(entry.input, onChanged);
}
