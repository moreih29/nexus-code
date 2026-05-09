/** Reads the file from disk, detects binary content, and creates or updates the Monaco text model. */

import type * as Monaco from "monaco-editor";
import { ensureModelWithContent } from "./ensure-model";
import type { ModelEntryDeps } from "./model-entry";
import type { EditorInput } from "../types";

export interface ReadAndPlaceContentResult {
  model: Monaco.editor.ITextModel;
  content: string;
  isBinary: false;
  mtime: string;
  sizeBytes: number;
}

export interface ReadAndPlaceContentBinaryResult {
  isBinary: true;
}

export type ReadAndPlaceResult = ReadAndPlaceContentResult | ReadAndPlaceContentBinaryResult;

export async function readAndPlaceContent(
  input: EditorInput,
  monacoUri: Monaco.Uri,
  deps: Pick<ModelEntryDeps, "readFileForModel" | "requireMonaco">,
): Promise<ReadAndPlaceResult> {
  const result = await deps.readFileForModel(input);

  if (result.isBinary) {
    return { isBinary: true };
  }

  const monaco = deps.requireMonaco();
  const model = ensureModelWithContent(monaco, monacoUri, result.content);

  return {
    isBinary: false,
    model,
    content: result.content,
    mtime: result.mtime,
    sizeBytes: result.sizeBytes,
  };
}
