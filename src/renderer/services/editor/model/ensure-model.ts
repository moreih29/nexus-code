// Shared helper: get-or-create a Monaco text model and sync its content.
// Used by both loadEntry (model-entry.ts) and loadExternalEntry (load-external-entry.ts)
// to avoid repeating the getModel ?? createModel / setValue dance.

import type * as Monaco from "monaco-editor";

/**
 * Returns the existing model for `uri` if it exists, otherwise creates one.
 * If the model's current value differs from `content`, updates it in-place.
 */
export function ensureModelWithContent(
  monaco: { editor: Pick<typeof Monaco.editor, "getModel" | "createModel"> },
  uri: Monaco.Uri,
  content: string,
): Monaco.editor.ITextModel {
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri);

  if (model.getValue() !== content) {
    model.setValue(content);
  }

  return model;
}
