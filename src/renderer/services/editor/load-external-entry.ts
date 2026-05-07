// Sibling loader for external (out-of-workspace) files.
// Intentionally does NOT reuse loadEntry — external files skip dirty tracking,
// fs.changed subscriptions, and LSP open (Plan 20 Phase 1 decision).

import { absolutePathToFileUri } from "../../../shared/file-uri";
import { ipcCall } from "../../ipc/client";
import { errorCodeFromUnknown, type ModelEntry } from "./model-entry";
import { requireMonaco } from "./monaco-singleton";

export async function loadExternalEntry(input: {
  workspaceId: string;
  filePath: string;
}): Promise<ModelEntry> {
  const cacheUri = absolutePathToFileUri(input.filePath);
  const monaco = requireMonaco();
  const monacoUri = monaco.Uri.parse(cacheUri);

  const entry: ModelEntry = {
    input: {
      workspaceId: input.workspaceId,
      filePath: input.filePath,
      origin: "external",
      readOnly: true,
    },
    cacheUri,
    lspUri: monacoUri.toString(),
    monacoUri,
    languageId: "",
    refCount: 1,
    version: 1,
    phase: "loading",
    model: null,
    lastLoadedValue: "",
    loadPromise: Promise.resolve(),
    lspOpened: false,
    disposed: false,
    subscribers: new Set(),
    origin: "external",
    readOnly: true,
    originatingWorkspaceId: input.workspaceId,
  };

  try {
    const result = await ipcCall("fs", "readExternal", { absolutePath: input.filePath });

    if (result.isBinary) {
      entry.phase = "binary";
      return entry;
    }

    const model =
      monaco.editor.getModel(monacoUri) ??
      monaco.editor.createModel(result.content, undefined, monacoUri);

    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

    entry.model = model;
    entry.languageId = model.getLanguageId();
    entry.phase = "ready";
    entry.lastLoadedValue = result.content;
  } catch (error) {
    entry.phase = "error";
    entry.errorCode = errorCodeFromUnknown(error);
  }

  return entry;
}
