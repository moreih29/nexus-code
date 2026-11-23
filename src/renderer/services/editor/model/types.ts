import type * as Monaco from "monaco-editor";
import type { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import type { TextDocumentContentChangeEvent } from "../../../../shared/lsp";
import type { FileErrorCode } from "../../../utils/file-error";
import type { TextEncoding } from "../encoding/text-encoding";
import type { registerKnownModelUri, unregisterKnownModelUri } from "../lsp/known-uris";
import type { monacoContentChangesToLsp } from "../lsp/monaco-converters";
import type { EditorInput } from "../types";
import type { attachGitSubscription } from "./attach-git-subscription";
import type {
  attachDirtyTracker,
  detachDirtyTracker,
  getDirtyEntry,
  markSaved,
} from "./dirty-tracker";
import type { FileLoadResult, FsChangedForFile, workspaceRootForInput } from "./file-loader";

export type SharedModelPhase = "loading" | "ready" | "binary" | "error";

export interface SharedModelState {
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
  readOnly: boolean;
  diskDiverged?: { mtime: string; size: number };
}

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
  encoding?: TextEncoding;
  loadPromise: Promise<void>;
  contentDisposable?: Monaco.IDisposable;
  fsUnsubscribe?: () => void;
  gitUnsubscribe?: () => void;
  lspOpened: boolean;
  didOpenPromise?: Promise<void>;
  lspDegraded?: boolean;
  lspNeedsRehydrate?: boolean;
  diskReadSeq?: number;
  lspRehydrating?: boolean;
  lspOpenEpoch?: number;
  disposed: boolean;
  subscribers: Set<() => void>;
  origin: "workspace" | "external" | "untitled";
  readOnly: boolean;
  deps?: ModelEntryDeps;
  originatingWorkspaceId?: string;
  diskDiverged?: { mtime: string; size: number };
}

export interface ModelEntryDeps {
  attachDirtyTracker: typeof attachDirtyTracker;
  detachDirtyTracker: typeof detachDirtyTracker;
  markDirtyTrackerSaved: typeof markSaved;
  readFileForModel: (input: EditorInput, encoding?: TextEncoding) => Promise<FileLoadResult>;
  statFileForModel: (input: EditorInput) => Promise<{ mtime: string; size: number }>;
  getDirtyEntry: typeof getDirtyEntry;
  subscribeFsChanged: (
    input: EditorInput,
    onChange: (change: FsChangedForFile) => void,
  ) => () => void;
  subscribeGitStatusChanged: (input: EditorInput, onChanged: () => void) => () => void;
  attachGitSubscription: typeof attachGitSubscription;
  workspaceRootForInput: typeof workspaceRootForInput;
  isLspLanguage: (languageId: string) => boolean;
  isLspEnabledForWorkspace: (workspaceId: string, languageId: string) => boolean;
  ensureProvidersFor: (languageId: string) => void;
  monacoContentChangesToLsp: typeof monacoContentChangesToLsp;
  notifyDidOpen: (
    uri: string,
    workspaceId: string,
    workspaceRoot: string,
    languageId: string,
    version: number,
    text: string,
  ) => Promise<void>;
  notifyDidChange: (
    workspaceId: string,
    uri: string,
    version: number,
    contentChanges: TextDocumentContentChangeEvent[],
  ) => Promise<void>;
  notifyDidClose: (workspaceId: string, uri: string) => Promise<void>;
  registerKnownModelUri: typeof registerKnownModelUri;
  unregisterKnownModelUri: typeof unregisterKnownModelUri;
  requireMonaco: () => typeof Monaco;
  absolutePathToFileUri: typeof absolutePathToFileUri;
}
