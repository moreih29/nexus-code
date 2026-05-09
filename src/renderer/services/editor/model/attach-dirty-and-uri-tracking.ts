/** Attaches the dirty tracker to the model and registers both URIs in the LSP known-model map. */

import type * as Monaco from "monaco-editor";
import type { ModelEntryDeps } from "./model-entry";

export interface AttachDirtyAndUriTrackingOptions {
  cacheUri: string;
  lspUri: string;
  model: Monaco.editor.ITextModel;
  mtime: string;
  sizeBytes: number;
  deps: Pick<ModelEntryDeps, "attachDirtyTracker" | "registerKnownModelUri">;
}

export function attachDirtyAndUriTracking({
  cacheUri,
  lspUri,
  model,
  mtime,
  sizeBytes,
  deps,
}: AttachDirtyAndUriTrackingOptions): void {
  deps.attachDirtyTracker({
    cacheUri,
    model,
    loadedMtime: mtime,
    loadedSize: sizeBytes,
  });

  deps.registerKnownModelUri(cacheUri);
  deps.registerKnownModelUri(lspUri);
}
