import { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { requireMonaco } from "../runtime/monaco-singleton";
import { ensureModelWithContent } from "./ensure-model";
import { errorCodeFromUnknown } from "./entry";
import { decodeFileContent } from "./file-loader";
import type { ModelEntry } from "./types";

export async function loadExternalEntry(input: {
  workspaceId: string;
  filePath: string;
}): Promise<ModelEntry> {
  const cacheUri = workspaceUriFor(input.workspaceId, input.filePath);
  const lspUri = absolutePathToFileUri(input.filePath);
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
    lspUri,
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
    const result = unwrapIpcResult(
      await ipcCallResult("fs", "readExternal", {
        workspaceId: input.workspaceId,
        absolutePath: input.filePath,
      }),
    );

    if (result.kind === "missing") {
      entry.phase = "error";
      entry.errorCode = "NOT_FOUND";
      return entry;
    }

    if (result.isBinary) {
      entry.phase = "binary";
      return entry;
    }

    const { kind: _kind, ...read } = result;
    const decoded = decodeFileContent(read);
    const model = ensureModelWithContent(monaco, monacoUri, decoded.content);

    entry.model = model;
    entry.encoding = decoded.encoding;
    entry.languageId = model.getLanguageId();
    entry.phase = "ready";
    entry.lastLoadedValue = model.getValue();
  } catch (error) {
    entry.phase = "error";
    entry.errorCode = errorCodeFromUnknown(error);
  }

  return entry;
}
