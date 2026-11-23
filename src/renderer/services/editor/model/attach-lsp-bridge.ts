import type * as Monaco from "monaco-editor";
import { lspLanguageIdForUri, resolveLspPresetLanguageId } from "../../../../shared/lsp/config";
import type { ModelEntry, ModelEntryDeps } from "./types";

export interface AttachLspBridgeResult {
  contentDisposable: Monaco.IDisposable;
}

type RehydrateDeps = Pick<
  ModelEntryDeps,
  "isLspEnabledForWorkspace" | "ensureProvidersFor" | "notifyDidOpen" | "workspaceRootForInput"
>;

function presetLanguageIdFor(entry: ModelEntry): string {
  return resolveLspPresetLanguageId(entry.languageId) ?? entry.languageId;
}

export function rehydrateEntryLspOpened(entry: ModelEntry, deps: RehydrateDeps): Promise<void> {
  if (
    entry.disposed ||
    !entry.model ||
    entry.lspOpened ||
    !entry.lspNeedsRehydrate ||
    entry.lspRehydrating ||
    !deps.isLspEnabledForWorkspace(entry.input.workspaceId, presetLanguageIdFor(entry))
  ) {
    return entry.didOpenPromise ?? Promise.resolve();
  }
  deps.ensureProvidersFor(entry.languageId);
  entry.version = 1;
  const epoch = (entry.lspOpenEpoch ?? 0) + 1;
  entry.lspOpenEpoch = epoch;
  entry.lspRehydrating = true;
  const text = entry.model.getValue();
  const workspaceRoot = deps.workspaceRootForInput(entry.input);
  entry.didOpenPromise = deps
    .notifyDidOpen(
      entry.lspUri,
      entry.input.workspaceId,
      workspaceRoot,
      lspLanguageIdForUri(entry.languageId, entry.lspUri),
      entry.version,
      text,
    )
    .then(
      () => {
        if (entry.lspOpenEpoch !== epoch) return;
        entry.lspRehydrating = false;
        entry.lspOpened = true;
        entry.lspDegraded = false;
        entry.lspNeedsRehydrate = false;
      },
      () => {
        if (entry.lspOpenEpoch !== epoch) return;
        entry.lspRehydrating = false;
        entry.lspOpened = false;
        entry.lspDegraded = true;
      },
    );
  return entry.didOpenPromise;
}

export function attachLspBridge(
  entry: ModelEntry,
  workspaceRoot: string,
  deps: Pick<
    ModelEntryDeps,
    | "isLspLanguage"
    | "isLspEnabledForWorkspace"
    | "ensureProvidersFor"
    | "notifyDidOpen"
    | "notifyDidChange"
    | "monacoContentChangesToLsp"
    | "workspaceRootForInput"
  >,
): AttachLspBridgeResult {
  const model = entry.model;
  if (!model) throw new Error("attachLspBridge: the entry has no model yet");

  if (deps.isLspLanguage(entry.languageId)) {
    if (deps.isLspEnabledForWorkspace(entry.input.workspaceId, presetLanguageIdFor(entry))) {
      deps.ensureProvidersFor(entry.languageId);
      const openEpoch = entry.lspOpenEpoch ?? 0;
      entry.didOpenPromise = deps
        .notifyDidOpen(
          entry.lspUri,
          entry.input.workspaceId,
          workspaceRoot,
          lspLanguageIdForUri(entry.languageId, entry.lspUri),
          entry.version,
          entry.lastLoadedValue,
        )
        .then(
          () => {
            if ((entry.lspOpenEpoch ?? 0) !== openEpoch) return;
            entry.lspOpened = true;
          },
          () => {
            if ((entry.lspOpenEpoch ?? 0) !== openEpoch) return;
            entry.lspOpened = false;
            entry.lspDegraded = true;
          },
        );
    } else {
      entry.lspNeedsRehydrate = true;
    }
  }

  let waitingChanges = 0;

  const contentDisposable = model.onDidChangeContent((event) => {
    entry.version += 1;
    const version = entry.version;
    const epoch = entry.lspOpenEpoch ?? 0;
    const contentChanges = deps.monacoContentChangesToLsp(event.changes);
    if (contentChanges.length === 0) return;
    const send = () => {
      deps
        .notifyDidChange(entry.input.workspaceId, entry.lspUri, version, contentChanges)
        .catch(() => {
          entry.lspDegraded = true;
        });
    };
    if (entry.lspOpened && !entry.disposed && !entry.lspNeedsRehydrate && waitingChanges === 0) {
      send();
      return;
    }
    waitingChanges += 1;
    void (async () => {
      try {
        if (entry.lspNeedsRehydrate && !entry.disposed && deps.isLspLanguage(entry.languageId)) {
          await rehydrateEntryLspOpened(entry, deps);
        }
        await entry.didOpenPromise;
        if (!entry.lspOpened || entry.disposed) return;
        if ((entry.lspOpenEpoch ?? 0) !== epoch) return;
        send();
      } finally {
        waitingChanges -= 1;
      }
    })();
  });

  return { contentDisposable };
}
