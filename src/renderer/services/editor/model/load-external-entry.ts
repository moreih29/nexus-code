// Sibling loader for external (out-of-workspace) files.
// Intentionally does NOT reuse loadEntry — external files are read-only previews,
// so they skip dirty tracking, fs.changed subscriptions, and LSP open: there is no
// edit lifecycle to track, and routing LSP traffic for an unrelated workspace would
// confuse server roots.

import { absolutePathToFileUri } from "../../../../shared/file-uri";
import { ipcCall } from "../../../ipc/client";
import { requireMonaco } from "../runtime/monaco-singleton";
import { ensureModelWithContent } from "./ensure-model";
import { errorCodeFromUnknown, type ModelEntry } from "./model-entry";

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
    refCount: 0,
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
    const result = await ipcCall("fs", "readExternal", {
      workspaceId: input.workspaceId,
      absolutePath: input.filePath,
    });

    if (result.kind === "missing") {
      entry.phase = "error";
      entry.errorCode = "NOT_FOUND";
      return entry;
    }

    if (result.isBinary) {
      entry.phase = "binary";
      return entry;
    }

    const model = ensureModelWithContent(monaco, monacoUri, result.content);

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
