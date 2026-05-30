// Shared type definitions for the model layer.
// Extracted from entry.ts so that attach-* helpers and cache.ts can import
// types without creating a circular dependency back through entry.ts.
//
// Intentionally does NOT import from lsp/bridge (bridge → cache → types
// would be circular). Function shapes in ModelEntryDeps that belong to
// bridge are written as explicit inline signatures.

import type * as Monaco from "monaco-editor";
import type { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import type { TextDocumentContentChangeEvent } from "../../../../shared/lsp";
import type { FileErrorCode } from "../../../utils/file-error";
import type { registerKnownModelUri, unregisterKnownModelUri } from "../lsp/known-uris";
import type { monacoContentChangesToLsp } from "../lsp/monaco-converters";
import type { EditorInput } from "../types";
import type { attachGitSubscription } from "./attach-git-subscription";
import type { attachDirtyTracker, detachDirtyTracker, markSaved } from "./dirty-tracker";
import type { FileLoadResult, FsChangedForFile, workspaceRootForInput } from "./file-loader";

/** Lifecycle phase of a `ModelEntry`. */
export type SharedModelPhase = "loading" | "ready" | "binary" | "error";

/** Stable snapshot shape consumed by `useSyncExternalStore`. */
export interface SharedModelState {
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
  readOnly: boolean;
  /** Present when the on-disk file has changed while the buffer has unsaved edits. */
  diskDiverged?: { mtime: string; size: number };
}

/** Full in-memory record for a single open file. */
export interface ModelEntry {
  input: EditorInput;
  cacheUri: string;
  lspUri: string;
  monacoUri: Monaco.Uri;
  languageId: string;
  refCount: number;
  version: number;
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
  lastLoadedValue: string;
  loadPromise: Promise<void>;
  contentDisposable?: Monaco.IDisposable;
  fsUnsubscribe?: () => void;
  gitUnsubscribe?: () => void;
  lspOpened: boolean;
  didOpenPromise?: Promise<void>;
  lspDegraded?: boolean;
  /**
   * Sticky flag set by the cache when the main-side LSP host evicts this
   * workspace (LSP_MAX_ACTIVE_WORKSPACES). The content-change handler
   * uses it to distinguish "initial didOpen still pending" (false) from
   * "server-side state lost, re-issue didOpen before forwarding more
   * changes" (true). Cleared on a successful rehydrate.
   */
  lspNeedsRehydrate?: boolean;
  disposed: boolean;
  subscribers: Set<() => void>;
  origin: "workspace" | "external" | "untitled";
  readOnly: boolean;
  deps?: ModelEntryDeps;
  /** Set only when origin === "external"; identifies the workspace the opener came from. */
  originatingWorkspaceId?: string;
  /**
   * Set when the on-disk file has changed while the buffer has unsaved edits.
   * Holds the mtime/size that the disk currently has. Cleared when the entry
   * is re-synced with disk (non-dirty reload, explicit reload, or successful save).
   */
  diskDiverged?: { mtime: string; size: number };
}

/**
 * All injectable dependencies consumed by the model-entry lifecycle.
 *
 * Written as an explicit interface (rather than `typeof defaultModelEntryDeps`)
 * so that this module remains a dependency-free type leaf — importing bridge.ts
 * here would create a cycle (bridge → cache → types → bridge). The field set
 * and function signatures EXACTLY match `defaultModelEntryDeps` in entry.ts,
 * so all `Pick<ModelEntryDeps, ...>` usages in attach-* helpers continue to
 * compile correctly.
 */
export interface ModelEntryDeps {
  attachDirtyTracker: typeof attachDirtyTracker;
  detachDirtyTracker: typeof detachDirtyTracker;
  markDirtyTrackerSaved: typeof markSaved;
  readFileForModel: (input: EditorInput) => Promise<FileLoadResult>;
  subscribeFsChanged: (
    input: EditorInput,
    onChange: (change: FsChangedForFile) => void,
  ) => () => void;
  subscribeGitStatusChanged: (input: EditorInput, onChanged: () => void) => () => void;
  attachGitSubscription: typeof attachGitSubscription;
  workspaceRootForInput: typeof workspaceRootForInput;
  /** Returns true when `languageId` should be routed to the LSP server. */
  isLspLanguage: (languageId: string) => boolean;
  /** Returns true when LSP is enabled for the given workspace + language pair. */
  isLspEnabledForWorkspace: (workspaceId: string, languageId: string) => boolean;
  /** Ensures LSP language providers are registered for the given language id. */
  ensureProvidersFor: (languageId: string) => void;
  monacoContentChangesToLsp: typeof monacoContentChangesToLsp;
  /** Sends `textDocument/didOpen` to the LSP server. */
  notifyDidOpen: (
    uri: string,
    workspaceId: string,
    workspaceRoot: string,
    languageId: string,
    version: number,
    text: string,
  ) => Promise<void>;
  /** Sends `textDocument/didChange` to the LSP server. */
  notifyDidChange: (
    workspaceId: string,
    uri: string,
    version: number,
    contentChanges: TextDocumentContentChangeEvent[],
  ) => Promise<void>;
  /** Sends `textDocument/didClose` to the LSP server. */
  notifyDidClose: (workspaceId: string, uri: string) => Promise<void>;
  registerKnownModelUri: typeof registerKnownModelUri;
  unregisterKnownModelUri: typeof unregisterKnownModelUri;
  requireMonaco: () => typeof Monaco;
  absolutePathToFileUri: typeof absolutePathToFileUri;
}
