/** Sends LSP didOpen and wires the model's content-change listener to forward didChange notifications. */

import type * as Monaco from "monaco-editor";
import type { ModelEntry, ModelEntryDeps } from "./entry";

export interface AttachLspBridgeResult {
  contentDisposable: Monaco.IDisposable;
}

export function attachLspBridge(
  entry: ModelEntry,
  workspaceRoot: string,
  deps: Pick<
    ModelEntryDeps,
    | "isLspLanguage"
    | "ensureProvidersFor"
    | "notifyDidOpen"
    | "notifyDidChange"
    | "monacoContentChangesToLsp"
  >,
): AttachLspBridgeResult {
  const model = entry.model!;

  if (deps.isLspLanguage(entry.languageId)) {
    deps.ensureProvidersFor(entry.languageId);
    entry.didOpenPromise = deps
      .notifyDidOpen(
        entry.lspUri,
        entry.input.workspaceId,
        workspaceRoot,
        entry.languageId,
        entry.version,
        entry.lastLoadedValue,
      )
      .then(
        () => {
          entry.lspOpened = true;
        },
        () => {
          entry.lspOpened = false;
          entry.lspDegraded = true;
        },
      );
  }

  const contentDisposable = model.onDidChangeContent(async (event) => {
    entry.version += 1;
    const version = entry.version;
    const contentChanges = deps.monacoContentChangesToLsp(event.changes);
    if (contentChanges.length === 0) return;
    await entry.didOpenPromise;
    if (!entry.lspOpened || entry.disposed) return;
    deps.notifyDidChange(entry.lspUri, version, contentChanges).catch(() => {
      entry.lspDegraded = true;
    });
  });

  return { contentDisposable };
}
