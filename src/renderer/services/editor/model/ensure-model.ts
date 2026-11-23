import type * as Monaco from "monaco-editor";

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
