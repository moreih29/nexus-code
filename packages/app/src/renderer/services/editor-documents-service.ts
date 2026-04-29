import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  EditorBridgeRequest,
  EditorBridgeResultFor,
  LspDiagnostic,
  LspStatus,
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
  WorkspaceFileReadResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  WORKSPACE_EDIT_CLOSED_FILE_WARNING_THRESHOLD,
  applyLspTextEdits,
  detectLspLanguage,
  diffTabIdFor,
  monacoLanguageIdForPath,
  tabIdFor,
  titleForPath,
  type EditorBridge,
  type EditorDiffSide,
  type EditorTab,
  type EditorTabId,
  type OpenDiffTabOptions,
  type OpenDiffTabSide,
} from "./editor-types";

export type EditorDocumentId = EditorTabId;
export type EditorDocument = EditorTab;

// Boundary with ILspService: IEditorDocumentsService owns document content,
// dirty/save state, diff documents, diagnostics fan-in, and WorkspaceEdit
// application; ILspService pushes/coordinates language-server data.
export interface IEditorDocumentsService {
  documentsById: Record<EditorDocumentId, EditorDocument>;
  activeDocumentId: EditorDocumentId | null;
  diagnosticsByDocument: Record<string, LspDiagnostic[]>;
  lspStatuses: Record<string, LspStatus>;
  openDocument(workspaceId: WorkspaceId, path: string): Promise<EditorDocument>;
  closeDocument(documentId: EditorDocumentId): Promise<void>;
  getDocument(documentId: EditorDocumentId): EditorDocument | null;
  getDocumentByWorkspacePath(workspaceId: WorkspaceId, path: string): EditorDocument | null;
  getContent(documentId: EditorDocumentId): string | null;
  setContent(documentId: EditorDocumentId, content: string): void;
  updateDocumentContent(documentId: EditorDocumentId, content: string): Promise<void>;
  markDirty(documentId: EditorDocumentId, dirty?: boolean): void;
  saveDocument(documentId: EditorDocumentId): Promise<void>;
  setDiagnostics(workspaceId: WorkspaceId, path: string, diagnostics: LspDiagnostic[]): void;
  getDiagnostics(workspaceId: WorkspaceId, path: string): LspDiagnostic[];
  setLspStatus(workspaceId: WorkspaceId, status: LspStatus): void;
  openDiff(
    left: OpenDiffTabSide,
    right: OpenDiffTabSide,
    options?: OpenDiffTabOptions,
  ): Promise<EditorDocument>;
  applyWorkspaceEdit(
    workspaceId: WorkspaceId,
    edit: LspWorkspaceEdit,
  ): Promise<LspWorkspaceEditApplicationResult>;
}

export type EditorDocumentsServiceStore = StoreApi<IEditorDocumentsService>;
export type EditorDocumentsServiceState = Pick<
  IEditorDocumentsService,
  "documentsById" | "activeDocumentId" | "diagnosticsByDocument" | "lspStatuses"
>;

const DEFAULT_EDITOR_DOCUMENTS_STATE: EditorDocumentsServiceState = {
  documentsById: {},
  activeDocumentId: null,
  diagnosticsByDocument: {},
  lspStatuses: {},
};

const UNAVAILABLE_EDITOR_DOCUMENTS_BRIDGE: EditorBridge = {
  async invoke<TRequest extends EditorBridgeRequest>(
    request: TRequest,
  ): Promise<EditorBridgeResultFor<TRequest>> {
    throw new Error(`Editor documents service bridge is unavailable for ${request.type}.`);
  },
};

export function createEditorDocumentsService(
  bridge: EditorBridge = UNAVAILABLE_EDITOR_DOCUMENTS_BRIDGE,
  initialState: Partial<EditorDocumentsServiceState> = {},
): EditorDocumentsServiceStore {
  return createStore<IEditorDocumentsService>((set, get) => ({
    ...DEFAULT_EDITOR_DOCUMENTS_STATE,
    ...initialState,
    async openDocument(workspaceId, path) {
      const existingDocument = get().documentsById[tabIdFor(workspaceId, path)];
      if (existingDocument?.kind === "file") {
        set({ activeDocumentId: existingDocument.id });
        return existingDocument;
      }

      const document = await readFileDocument(bridge, get(), workspaceId, path);
      set((state) => ({
        documentsById: {
          ...state.documentsById,
          [document.id]: document,
        },
        activeDocumentId: document.id,
      }));
      await notifyLspDocumentOpened(bridge, set, document);
      return get().documentsById[document.id] ?? document;
    },
    async closeDocument(documentId) {
      const document = get().documentsById[documentId];
      if (!document) {
        return;
      }

      set((state) => {
        const documentsById = { ...state.documentsById };
        delete documentsById[documentId];
        const nextActiveDocumentId = state.activeDocumentId === documentId
          ? Object.keys(documentsById)[0] ?? null
          : state.activeDocumentId;

        return {
          documentsById,
          activeDocumentId: nextActiveDocumentId,
          diagnosticsByDocument: document.kind === "file"
            ? omitRecordKey(state.diagnosticsByDocument, documentKey(document.workspaceId, document.path))
            : state.diagnosticsByDocument,
        };
      });
      await notifyLspDocumentClosed(bridge, document);
    },
    getDocument(documentId) {
      return get().documentsById[documentId] ?? null;
    },
    getDocumentByWorkspacePath(workspaceId, path) {
      return findFileDocumentByWorkspacePath(get().documentsById, workspaceId, path);
    },
    getContent(documentId) {
      return get().documentsById[documentId]?.content ?? null;
    },
    setContent(documentId, content) {
      set((state) => {
        const document = state.documentsById[documentId];
        if (!isEditableFileDocument(document)) {
          return state;
        }

        return {
          documentsById: {
            ...state.documentsById,
            [documentId]: {
              ...document,
              content,
              dirty: content !== document.savedContent,
              errorMessage: null,
              lspDocumentVersion: document.content === content
                ? document.lspDocumentVersion
                : document.lspDocumentVersion + 1,
            },
          },
        };
      });
    },
    async updateDocumentContent(documentId, content) {
      const document = get().documentsById[documentId];
      if (!isEditableFileDocument(document)) {
        return;
      }

      const contentChanged = document.content !== content;
      const nextDocumentVersion = contentChanged ? document.lspDocumentVersion + 1 : document.lspDocumentVersion;
      set((state) => updateDocument(state, documentId, (currentDocument) => ({
        ...currentDocument,
        content,
        dirty: true,
        errorMessage: null,
        lspDocumentVersion: currentDocument.content === content
          ? currentDocument.lspDocumentVersion
          : Math.max(currentDocument.lspDocumentVersion + 1, nextDocumentVersion),
      })));

      if (!document.language || !contentChanged) {
        return;
      }

      try {
        const result = await bridge.invoke({
          type: "lsp-document/change",
          workspaceId: document.workspaceId,
          path: document.path,
          language: document.language,
          content,
          version: nextDocumentVersion,
        });
        applyLspStatus(set, get, document.workspaceId, result.status);
      } catch (error) {
        set((state) => updateDocument(state, documentId, (currentDocument) => ({
          ...currentDocument,
          errorMessage: errorMessage(error, "Unable to update language server."),
        })));
      }
    },
    markDirty(documentId, dirty = true) {
      set((state) => {
        const document = state.documentsById[documentId];
        if (!isEditableFileDocument(document)) {
          return state;
        }

        return {
          documentsById: {
            ...state.documentsById,
            [documentId]: {
              ...document,
              dirty,
            },
          },
        };
      });
    },
    async saveDocument(documentId) {
      const document = get().documentsById[documentId];
      if (!isEditableFileDocument(document)) {
        return;
      }

      const contentToSave = document.content;
      set((state) => updateDocument(state, documentId, (currentDocument) => ({
        ...currentDocument,
        saving: true,
        errorMessage: null,
      })));

      try {
        const result = await bridge.invoke({
          type: "workspace-files/file/write",
          workspaceId: document.workspaceId,
          path: document.path,
          content: contentToSave,
          encoding: "utf8",
          expectedVersion: document.version,
        });
        set((state) => updateDocument(state, documentId, (currentDocument) => ({
          ...currentDocument,
          version: result.version,
          savedContent: contentToSave,
          dirty: currentDocument.content !== contentToSave,
          saving: false,
          errorMessage: null,
        })));
      } catch (error) {
        set((state) => updateDocument(state, documentId, (currentDocument) => ({
          ...currentDocument,
          saving: false,
          errorMessage: errorMessage(error, "Unable to save file."),
        })));
      }
    },
    setDiagnostics(workspaceId, path, diagnostics) {
      const key = documentKey(workspaceId, path);
      set((state) => ({
        diagnosticsByDocument: {
          ...state.diagnosticsByDocument,
          [key]: diagnostics,
        },
        documentsById: mapDocuments(
          state.documentsById,
          (document) => document.kind === "file" && document.workspaceId === workspaceId && document.path === path,
          (document) => ({ ...document, diagnostics }),
        ),
      }));
    },
    getDiagnostics(workspaceId, path) {
      return get().diagnosticsByDocument[documentKey(workspaceId, path)] ?? [];
    },
    setLspStatus(workspaceId, status) {
      applyLspStatus(set, get, workspaceId, status);
    },
    async openDiff(left, right, options = {}) {
      const [leftSide, rightSide] = await Promise.all([
        resolveDiffSide(bridge, left),
        resolveDiffSide(bridge, right),
      ]);
      const workspaceId = rightSide.workspaceId;
      const source = options.source ?? "manual";
      const documentId = options.id ?? diffTabIdFor(workspaceId, leftSide, rightSide, source);
      const existingDocument = get().documentsById[documentId];
      if (existingDocument?.kind === "diff") {
        set({ activeDocumentId: documentId });
        return existingDocument;
      }

      const document: EditorDocument = {
        kind: "diff",
        id: documentId,
        workspaceId,
        path: `${leftSide.path} ↔ ${rightSide.path}`,
        title: options.title ?? diffDocumentTitle(leftSide, rightSide),
        content: "",
        savedContent: "",
        version: "",
        dirty: false,
        saving: false,
        errorMessage: null,
        language: null,
        monacoLanguage: "plaintext",
        lspDocumentVersion: 0,
        diagnostics: [],
        lspStatus: null,
        readOnly: true,
        diff: {
          left: leftSide,
          right: rightSide,
          source,
        },
      };

      set((state) => ({
        documentsById: {
          ...state.documentsById,
          [document.id]: document,
        },
        activeDocumentId: document.id,
      }));
      return get().documentsById[document.id] ?? document;
    },
    async applyWorkspaceEdit(workspaceId, edit) {
      const plan = await planWorkspaceEditApplication(get(), bridge, workspaceId, edit);
      if (plan.updates.size === 0) {
        return {
          applied: false,
          appliedPaths: [],
          skippedClosedPaths: plan.skippedClosedPaths,
          skippedReadFailures: plan.skippedReadFailures,
          skippedUnsupportedPaths: plan.skippedUnsupportedPaths,
        };
      }

      set((state) => {
        let documentsById = state.documentsById;
        for (const [path, update] of plan.updates) {
          const document = findFileDocumentByWorkspacePath(documentsById, workspaceId, path)
            ?? plan.closedDocuments.find((closedDocument) => closedDocument.path === path)
            ?? null;
          if (!document) {
            continue;
          }

          documentsById = {
            ...documentsById,
            [document.id]: {
              ...document,
              content: update.content,
              dirty: update.content !== document.savedContent,
              errorMessage: null,
              lspDocumentVersion: update.lspDocumentVersion,
              diagnostics: state.diagnosticsByDocument[documentKey(workspaceId, document.path)]
                ?? document.diagnostics,
            },
          };
        }

        return { documentsById };
      });

      await Promise.all(
        Array.from(plan.updates.entries()).map(async ([path, update]) => {
          if (!update.language) {
            return;
          }

          try {
            const result = await bridge.invoke({
              type: "lsp-document/change",
              workspaceId,
              path,
              language: update.language,
              content: update.content,
              version: update.lspDocumentVersion,
            });
            applyLspStatus(set, get, workspaceId, result.status);
          } catch (error) {
            const document = findFileDocumentByWorkspacePath(get().documentsById, workspaceId, path);
            if (!document) {
              return;
            }
            set((state) => updateDocument(state, document.id, (currentDocument) => ({
              ...currentDocument,
              errorMessage: errorMessage(error, "Unable to update language server."),
            })));
          }
        }),
      );

      return {
        applied: true,
        appliedPaths: Array.from(plan.updates.keys()),
        skippedClosedPaths: plan.skippedClosedPaths,
        skippedReadFailures: plan.skippedReadFailures,
        skippedUnsupportedPaths: plan.skippedUnsupportedPaths,
      };
    },
  }));
}

function updateDocument(
  state: IEditorDocumentsService,
  documentId: EditorDocumentId,
  mapper: (document: EditorDocument) => EditorDocument,
): Partial<IEditorDocumentsService> | IEditorDocumentsService {
  const document = state.documentsById[documentId];
  if (!document) {
    return state;
  }

  return {
    documentsById: {
      ...state.documentsById,
      [documentId]: mapper(document),
    },
  };
}

function mapDocuments(
  documentsById: Record<EditorDocumentId, EditorDocument>,
  predicate: (document: EditorDocument) => boolean,
  mapper: (document: EditorDocument) => EditorDocument,
): Record<EditorDocumentId, EditorDocument> {
  let changed = false;
  const nextDocumentsById: Record<EditorDocumentId, EditorDocument> = {};
  for (const [documentId, document] of Object.entries(documentsById)) {
    if (predicate(document)) {
      nextDocumentsById[documentId] = mapper(document);
      changed = true;
    } else {
      nextDocumentsById[documentId] = document;
    }
  }

  return changed ? nextDocumentsById : documentsById;
}

function isEditableFileDocument(document: EditorDocument | undefined): document is EditorDocument {
  return document?.kind === "file" && !document.readOnly;
}

async function readFileDocument(
  bridge: EditorBridge,
  state: Pick<IEditorDocumentsService, "diagnosticsByDocument" | "lspStatuses">,
  workspaceId: WorkspaceId,
  path: string,
): Promise<EditorDocument> {
  const result = await bridge.invoke({
    type: "workspace-files/file/read",
    workspaceId,
    path,
  });
  return createFileDocumentFromReadResult(result, state.diagnosticsByDocument, state.lspStatuses);
}

function createFileDocumentFromReadResult(
  result: WorkspaceFileReadResult,
  diagnosticsByDocument: Record<string, LspDiagnostic[]>,
  lspStatuses: Record<string, LspStatus>,
): EditorDocument {
  const language = detectLspLanguage(result.path);
  return {
    kind: "file",
    id: tabIdFor(result.workspaceId, result.path),
    workspaceId: result.workspaceId,
    path: result.path,
    title: titleForPath(result.path),
    content: result.content,
    savedContent: result.content,
    version: result.version,
    dirty: false,
    saving: false,
    errorMessage: null,
    language,
    monacoLanguage: monacoLanguageIdForPath(result.path, language),
    lspDocumentVersion: 1,
    diagnostics: diagnosticsByDocument[documentKey(result.workspaceId, result.path)] ?? [],
    lspStatus: language ? lspStatuses[lspStatusKey(result.workspaceId, language)] ?? null : null,
  };
}

async function resolveDiffSide(
  bridge: EditorBridge,
  side: OpenDiffTabSide,
): Promise<EditorDiffSide> {
  if (side.content !== undefined) {
    const language = side.language === undefined ? detectLspLanguage(side.path) : side.language;
    return {
      workspaceId: side.workspaceId,
      path: side.path,
      title: side.title ?? titleForPath(side.path),
      content: side.content,
      language,
      monacoLanguage: side.monacoLanguage ?? monacoLanguageIdForPath(side.path, language),
    };
  }

  const readResult = await bridge.invoke({
    type: "workspace-files/file/read",
    workspaceId: side.workspaceId,
    path: side.path,
  });
  const language = side.language === undefined ? detectLspLanguage(readResult.path) : side.language;
  return {
    workspaceId: side.workspaceId,
    path: readResult.path,
    title: side.title ?? titleForPath(readResult.path),
    content: readResult.content,
    language,
    monacoLanguage: side.monacoLanguage ?? monacoLanguageIdForPath(readResult.path, language),
  };
}

function diffDocumentTitle(
  left: Pick<EditorDiffSide, "title">,
  right: Pick<EditorDiffSide, "title">,
): string {
  return `${left.title} ↔ ${right.title}`;
}

interface WorkspaceEditApplicationPlan {
  updates: Map<
    string,
    {
      content: string;
      language: EditorDocument["language"];
      lspDocumentVersion: number;
    }
  >;
  closedDocuments: EditorDocument[];
  skippedClosedPaths: string[];
  skippedReadFailures: string[];
  skippedUnsupportedPaths: string[];
}

async function planWorkspaceEditApplication(
  state: Pick<IEditorDocumentsService, "documentsById" | "diagnosticsByDocument">,
  bridge: EditorBridge,
  workspaceId: WorkspaceId,
  edit: LspWorkspaceEdit,
): Promise<WorkspaceEditApplicationPlan> {
  const openDocumentsByPath = new Map<string, EditorDocument>();
  for (const document of Object.values(state.documentsById)) {
    if (document.kind === "file" && document.workspaceId === workspaceId && !openDocumentsByPath.has(document.path)) {
      openDocumentsByPath.set(document.path, document);
    }
  }

  const closedPaths = collectClosedWorkspaceEditPaths(openDocumentsByPath, edit);
  if (closedPaths.length > WORKSPACE_EDIT_CLOSED_FILE_WARNING_THRESHOLD) {
    console.warn(
      `Editor documents service: WorkspaceEdit will open ${closedPaths.length} closed files as dirty documents.`,
      { workspaceId, paths: closedPaths },
    );
  }

  const closedFileReads = await Promise.all(
    closedPaths.map((path) => readClosedWorkspaceEditFile(bridge, state, workspaceId, path)),
  );
  const closedDocumentsByRequestedPath = new Map<string, EditorDocument>();
  const closedDocuments: EditorDocument[] = [];
  const skippedReadFailures: string[] = [];
  for (const read of closedFileReads) {
    if (read.document) {
      closedDocumentsByRequestedPath.set(read.requestedPath, read.document);
      closedDocuments.push(read.document);
    } else {
      skippedReadFailures.push(read.requestedPath);
    }
  }

  const updates = new Map<
    string,
    {
      content: string;
      lspDocumentVersion: number;
    }
  >();
  const skippedClosedPaths: string[] = [];
  const skippedUnsupportedPaths: string[] = [];

  for (const change of edit.changes) {
    if (change.edits.length === 0) {
      continue;
    }

    const document = openDocumentsByPath.get(change.path) ?? closedDocumentsByRequestedPath.get(change.path);
    if (!document) {
      if (!skippedReadFailures.includes(change.path)) {
        skippedClosedPaths.push(change.path);
      }
      continue;
    }

    try {
      const updatePath = document.path;
      const baseContent = updates.get(updatePath)?.content ?? document.content;
      const nextContent = applyLspTextEdits(baseContent, change.edits);
      const baseVersion = updates.get(updatePath)?.lspDocumentVersion ?? document.lspDocumentVersion;
      updates.set(updatePath, {
        content: nextContent,
        language: document.language,
        lspDocumentVersion: baseVersion + 1,
      });
    } catch {
      skippedUnsupportedPaths.push(change.path);
    }
  }

  return {
    updates,
    closedDocuments,
    skippedClosedPaths,
    skippedReadFailures,
    skippedUnsupportedPaths,
  };
}

function collectClosedWorkspaceEditPaths(
  openDocumentsByPath: ReadonlyMap<string, EditorDocument>,
  edit: LspWorkspaceEdit,
): string[] {
  const closedPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const change of edit.changes) {
    if (change.edits.length === 0 || openDocumentsByPath.has(change.path) || seenPaths.has(change.path)) {
      continue;
    }
    seenPaths.add(change.path);
    closedPaths.push(change.path);
  }
  return closedPaths;
}

interface ClosedWorkspaceEditFileRead {
  requestedPath: string;
  document: EditorDocument | null;
}

async function readClosedWorkspaceEditFile(
  bridge: EditorBridge,
  state: Pick<IEditorDocumentsService, "diagnosticsByDocument" | "lspStatuses">,
  workspaceId: WorkspaceId,
  path: string,
): Promise<ClosedWorkspaceEditFileRead> {
  try {
    const document = await readFileDocument(bridge, state, workspaceId, path);
    return {
      requestedPath: path,
      document,
    };
  } catch (error) {
    console.warn("Editor documents service: failed to read closed file for WorkspaceEdit.", {
      workspaceId,
      path,
      error,
    });
    return {
      requestedPath: path,
      document: null,
    };
  }
}

function findFileDocumentByWorkspacePath(
  documentsById: Record<EditorDocumentId, EditorDocument>,
  workspaceId: WorkspaceId,
  path: string,
): EditorDocument | null {
  return Object.values(documentsById).find((document) =>
    document.kind === "file" && document.workspaceId === workspaceId && document.path === path,
  ) ?? null;
}

async function notifyLspDocumentOpened(
  bridge: EditorBridge,
  set: EditorDocumentsServiceStore["setState"],
  document: EditorDocument,
): Promise<void> {
  if (!document.language) {
    return;
  }

  try {
    const openResult = await bridge.invoke({
      type: "lsp-document/open",
      workspaceId: document.workspaceId,
      path: document.path,
      language: document.language,
      content: document.content,
      version: document.lspDocumentVersion,
    });
    set((state) => applyLspStatusChange(state, document.workspaceId, openResult.status));
    const diagnosticsResult = await bridge.invoke({
      type: "lsp-diagnostics/read",
      workspaceId: document.workspaceId,
      path: document.path,
      language: document.language,
    });
    set((state) => ({
      diagnosticsByDocument: {
        ...state.diagnosticsByDocument,
        [documentKey(document.workspaceId, document.path)]: diagnosticsResult.diagnostics,
      },
      documentsById: mapDocuments(
        state.documentsById,
        (candidate) =>
          candidate.kind === "file" &&
          candidate.workspaceId === document.workspaceId &&
          candidate.path === document.path,
        (candidate) => ({ ...candidate, diagnostics: diagnosticsResult.diagnostics }),
      ),
    }));
  } catch (error) {
    set((state) => updateDocument(state, document.id, (currentDocument) => ({
      ...currentDocument,
      errorMessage: errorMessage(error, "Unable to initialize language server."),
    })));
  }
}

async function notifyLspDocumentClosed(
  bridge: EditorBridge,
  document: EditorDocument,
): Promise<void> {
  if (!document.language) {
    return;
  }

  try {
    await bridge.invoke({
      type: "lsp-document/close",
      workspaceId: document.workspaceId,
      path: document.path,
      language: document.language,
    });
  } catch (error) {
    console.error("Editor documents service: failed to close LSP document.", error);
  }
}

function applyLspStatus(
  set: EditorDocumentsServiceStore["setState"],
  get: EditorDocumentsServiceStore["getState"],
  workspaceId: WorkspaceId,
  status: LspStatus,
): void {
  set(applyLspStatusChange(get(), workspaceId, status));
}

function applyLspStatusChange(
  state: IEditorDocumentsService,
  workspaceId: WorkspaceId,
  status: LspStatus,
): Partial<IEditorDocumentsService> {
  const key = lspStatusKey(workspaceId, status.language);
  return {
    lspStatuses: {
      ...state.lspStatuses,
      [key]: status,
    },
    documentsById: mapDocuments(
      state.documentsById,
      (document) => document.workspaceId === workspaceId && document.language === status.language,
      (document) => ({ ...document, lspStatus: status }),
    ),
  };
}

function lspStatusKey(workspaceId: WorkspaceId, language: string): string {
  return `${workspaceId}:${language}`;
}

function documentKey(workspaceId: WorkspaceId, path: string): string {
  return `${workspaceId}:${path}`;
}

function omitRecordKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
