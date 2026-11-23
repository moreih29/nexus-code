import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { parseWorkspaceUri, workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import { resolveLspPresetLanguageId } from "../../../../shared/lsp/config";
import { type Tab, useTabsStore } from "../../../state/stores/tabs";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../../state/stores/workspaces";
import { registerWorkspaceCleanup } from "../../../state/workspace-cleanup";
import type { FileErrorCode } from "../../../utils/file-error";
import type { TextEncoding } from "../encoding/text-encoding";
import { registerKnownModelUri } from "../lsp/known-uris";
import { initializeMonacoSingleton, requireMonaco } from "../runtime/monaco-singleton";
import { workingFileOfDiff } from "../tabs/diff-working-file";
import { attachDirtyTracker, isDirty } from "./dirty-tracker";
import {
  cleanupEntry,
  createEntry,
  createUntitledEntry,
  errorCodeFromUnknown,
  notifySubscribers,
  reconcileIfStatChanged,
  rehydrateEntry,
  reloadEntryFromDisk,
  snapshot,
} from "./entry";
import { loadExternalEntry } from "./load-external-entry";
import type { ModelEntry, SharedModelState } from "./types";

export { isMonacoReady, onMonacoReady } from "../runtime/monaco-singleton";
export type { SharedModelPhase, SharedModelState } from "./types";

import type { EditorInput } from "../types";

export interface ReleasedModelInfo {
  input: EditorInput;
  cacheUri: string;
  lspUri: string;
  languageId: string;
}

export type ModelReleaseSubscriber = (released: ReleasedModelInfo) => void;

export function cacheUriFor(workspaceId: string, filePath: string): string {
  return workspaceUriFor(workspaceId, filePath);
}

export function cacheUriToFilePath(cacheUri: string): string | null {
  const workspaceParsed = parseWorkspaceUri(cacheUri);
  if (workspaceParsed) return workspaceParsed.absolutePath;
  return fileUriToAbsolutePath(cacheUri);
}

export function parseCacheUri(cacheUri: string): { workspaceId: string; filePath: string } | null {
  const parsed = parseWorkspaceUri(cacheUri);
  return parsed ? { workspaceId: parsed.workspaceId, filePath: parsed.absolutePath } : null;
}

export function initializeModelCache(monaco: typeof Monaco): void {
  initializeMonacoSingleton(monaco);

  registerWorkspaceCleanup(forceDisposeExternalsForWorkspace);
}

const entries = new Map<string, ModelEntry>();
const retainedByTabs = new Map<string, ModelEntry>();

const pendingExternalLoads = new Map<string, Promise<ModelEntry>>();
const releaseSubscribers = new Set<ModelReleaseSubscriber>();

function cacheUriForInput(input: EditorInput): string {
  if (input.origin === "untitled") {
    return `untitled://${input.workspaceId}/${input.filePath}`;
  }
  return cacheUriFor(input.workspaceId, input.filePath);
}

function hasOpenBufferTab(entry: ModelEntry, tabs: Record<string, Tab> | undefined): boolean {
  if (!tabs) return false;
  const { filePath, workspaceId } = entry.input;
  return Object.values(tabs).some((tab) => {
    if (entry.origin === "untitled") {
      return tab.type === "untitled" && `Untitled-${tab.props.untitledIndex}` === filePath;
    }
    if (tab.type === "editor") {
      return tab.props.origin !== "external" && tab.props.filePath === filePath;
    }
    return (
      tab.type === "editor.diff" &&
      tab.props.workspaceId === workspaceId &&
      workingFileOfDiff(tab.props) === filePath
    );
  });
}

useTabsStore.subscribe((state, previous) => {
  for (const [cacheUri, entry] of retainedByTabs) {
    const { workspaceId } = entry.input;
    const tabs = state.byWorkspace[workspaceId];
    if (tabs !== previous.byWorkspace[workspaceId] && !hasOpenBufferTab(entry, tabs)) {
      disposeReleasedEntry(cacheUri, entry);
    }
  }
});

export function subscribeOnRelease(callback: ModelReleaseSubscriber): () => void {
  releaseSubscribers.add(callback);
  return () => {
    releaseSubscribers.delete(callback);
  };
}

function notifyReleased(released: ReleasedModelInfo): void {
  for (const subscriber of releaseSubscribers) {
    try {
      subscriber(released);
    } catch {}
  }
}

export function subscribeModel(input: EditorInput, onChange: () => void): () => void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return () => {};
  entry.subscribers.add(onChange);
  return () => {
    entry.subscribers.delete(onChange);
  };
}

export function getModelSnapshot(input: EditorInput): SharedModelState | null {
  const entry = entries.get(cacheUriForInput(input));
  return entry ? snapshot(entry) : null;
}

export function toFileErrorCode(error: unknown): FileErrorCode {
  return errorCodeFromUnknown(error);
}

export async function acquireModel(input: EditorInput): Promise<SharedModelState> {
  const cacheUri = cacheUriForInput(input);
  let entry = entries.get(cacheUri);
  if (!entry) {
    if (input.origin === "external") {
      let pending = pendingExternalLoads.get(cacheUri);
      if (!pending) {
        pending = loadExternalEntry(input).finally(() => pendingExternalLoads.delete(cacheUri));
        pendingExternalLoads.set(cacheUri, pending);
      }
      const loaded = await pending;
      entry = entries.get(cacheUri) ?? loaded;
    } else if (input.origin === "untitled") {
      entry = createUntitledEntry(input, cacheUri, {
        requireMonaco,
        attachDirtyTracker,
        registerKnownModelUri,
      });
    } else {
      entry = createEntry(input, cacheUri);
    }
    entries.set(cacheUri, entry);
  }

  entry.refCount += 1;
  if (
    retainedByTabs.delete(cacheUri) &&
    entry.origin === "workspace" &&
    selectIsWorkspaceOnline(useWorkspacesStore.getState(), input.workspaceId)
  ) {
    void reconcileIfStatChanged(entry);
  }
  try {
    await entry.loadPromise;
    return snapshot(entry);
  } catch (error) {
    entry.refCount -= 1;
    if (entry.refCount === 0 && entries.get(cacheUri) === entry) {
      entries.delete(cacheUri);
      cleanupEntry(entry);
    }
    throw error;
  }
}

export function releaseModel(input: EditorInput): void {
  const cacheUri = cacheUriForInput(input);
  const entry = entries.get(cacheUri);
  if (!entry || entry.refCount === 0) return;

  entry.refCount -= 1;
  if (entry.refCount > 0) return;

  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.id === input.workspaceId);
  if (
    workspace &&
    (workspace.location.kind !== "local" || isDirty(cacheUri)) &&
    entry.origin !== "external" &&
    entry.model &&
    !entry.model.isDisposed() &&
    hasOpenBufferTab(entry, useTabsStore.getState().byWorkspace[input.workspaceId])
  ) {
    retainedByTabs.set(cacheUri, entry);
    return;
  }

  disposeReleasedEntry(cacheUri, entry);
}

function disposeReleasedEntry(cacheUri: string, entry: ModelEntry): void {
  retainedByTabs.delete(cacheUri);
  entries.delete(cacheUri);
  const released: ReleasedModelInfo = {
    input: entry.input,
    cacheUri: entry.cacheUri,
    lspUri: entry.lspUri,
    languageId: entry.languageId,
  };
  cleanupEntry(entry);
  notifyReleased(released);
}

export interface ResolvedModelView {
  model: Monaco.editor.ITextModel;
  cacheUri: string;
  lspUri: string;
  workspaceId: string;
  filePath: string;
  languageId: string;
  readOnly: boolean;
  encoding: TextEncoding;
}

export function getResolvedModel(input: EditorInput): ResolvedModelView | null {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry || entry.phase !== "ready" || !entry.model) return null;
  return {
    model: entry.model,
    cacheUri: entry.cacheUri,
    lspUri: entry.lspUri,
    workspaceId: entry.input.workspaceId,
    filePath: entry.input.filePath,
    languageId: entry.languageId,
    readOnly: entry.readOnly,
    encoding: entry.encoding ?? "utf8",
  };
}

export interface EntryMetadata {
  workspaceId: string;
  filePath: string;
  origin: "workspace" | "external" | "untitled";
  readOnly: boolean;
}

export function getEntryMetadata(cacheUri: string): EntryMetadata | null {
  const entry = entries.get(cacheUri);
  if (!entry) return null;
  return {
    workspaceId: entry.input.workspaceId,
    filePath: entry.input.filePath,
    origin: entry.origin,
    readOnly: entry.readOnly,
  };
}

export function getEntryLspVersion(cacheUri: string): number | null {
  return entries.get(cacheUri)?.version ?? null;
}

export async function reconcileWatchedModel(input: EditorInput): Promise<void> {
  const entry = entries.get(cacheUriForInput(input));
  if (entry?.origin !== "workspace") return;
  await entry.loadPromise;
  await reconcileIfStatChanged(entry);
}

export async function reloadModelFromDisk(
  input: EditorInput,
  encoding?: TextEncoding,
  onReadFailure?: (error: unknown) => void,
): Promise<boolean> {
  const entry = entries.get(cacheUriForInput(input));
  return entry ? reloadEntryFromDisk(entry, encoding, onReadFailure) : false;
}

export function clearDiskDiverged(input: EditorInput): void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return;
  if (entry.diskDiverged === undefined) return;
  entry.diskDiverged = undefined;
  notifySubscribers(entry);
}

export function setModelEncoding(input: EditorInput, encoding: TextEncoding): void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry || entry.encoding === encoding) return;
  entry.encoding = encoding;
  notifySubscribers(entry);
}

export function syncLoadedValueAfterSave(input: EditorInput, content: string): void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return;
  entry.lastLoadedValue = content;
  entry.diskReadSeq = (entry.diskReadSeq ?? 0) + 1;
}

function entryUsesLspLanguage(entry: ModelEntry, languageId: string): boolean {
  return (
    entry.languageId === languageId || resolveLspPresetLanguageId(entry.languageId) === languageId
  );
}

export function resetLspStateForWorkspace(workspaceId: string, languageId?: string): void {
  for (const entry of entries.values()) {
    if (entry.input.workspaceId !== workspaceId) continue;
    if (languageId && !entryUsesLspLanguage(entry, languageId)) continue;
    if (entry.disposed) continue;
    entry.lspOpened = false;
    entry.lspNeedsRehydrate = true;
    entry.lspRehydrating = false;
    entry.lspOpenEpoch = (entry.lspOpenEpoch ?? 0) + 1;
    entry.didOpenPromise = Promise.resolve();
  }
}

export function rehydrateLspForWorkspace(workspaceId: string, languageId?: string): void {
  for (const entry of entries.values()) {
    if (entry.input.workspaceId !== workspaceId) continue;
    if (languageId && !entryUsesLspLanguage(entry, languageId)) continue;
    if (entry.disposed || entry.lspOpened) continue;
    if (!entry.lspNeedsRehydrate) continue;
    void rehydrateEntry(entry).catch(() => {});
  }
}

export function forceDisposeExternalsForWorkspace(workspaceId: string): void {
  for (const [cacheUri, entry] of entries) {
    const isExternalForWorkspace =
      entry.origin === "external" && entry.originatingWorkspaceId === workspaceId;
    const isUntitledForWorkspace =
      entry.origin === "untitled" && entry.input.workspaceId === workspaceId;
    if (isExternalForWorkspace || isUntitledForWorkspace) {
      retainedByTabs.delete(cacheUri);
      entries.delete(cacheUri);
      cleanupEntry(entry);
    }
  }
}
