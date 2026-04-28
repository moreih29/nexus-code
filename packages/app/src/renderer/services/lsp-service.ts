import { createStore, type StoreApi } from "zustand/vanilla";

import type { LspCompletionEditorApi } from "../editor/monaco-providers/completion-provider";
import type { LspDocumentSymbolsEditorApi } from "../editor/monaco-providers/document-symbols-provider";
import type {
  LspCompletionItem,
  LspDiagnostic,
  LspDiagnosticsEvent,
  LspDiagnosticsReadResult,
  LspDocumentChangeResult,
  LspDocumentCloseResult,
  LspDocumentOpenResult,
  LspDocumentSymbolItem,
  LspLanguage,
  LspStatus,
  LspStatusEvent,
  LspStatusReadResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type LspCompletionProviderRequest = Parameters<LspCompletionEditorApi["invoke"]>[0];
export type LspCompletionProviderResult = Awaited<ReturnType<LspCompletionEditorApi["invoke"]>>;
export type LspDocumentSymbolsProviderRequest = Parameters<LspDocumentSymbolsEditorApi["invoke"]>[0];
export type LspDocumentSymbolsProviderResult = Awaited<ReturnType<LspDocumentSymbolsEditorApi["invoke"]>>;

export interface LspDocumentRef {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  version: number;
  content?: string | null;
  openedAt?: string | null;
  changedAt?: string | null;
}

export interface LspDocumentChangeInput {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  version: number;
  content?: string | null;
  changedAt?: string | null;
}

export interface LspCompletionDocumentState {
  items: LspCompletionItem[];
  isIncomplete: boolean;
  completedAt: string | null;
}

export interface ILspService {
  diagnosticsByDocument: Record<string, LspDiagnostic[]>;
  diagnosticsReadAtByDocument: Record<string, string>;
  completionItemsByDocument: Record<string, LspCompletionItem[]>;
  completionStateByDocument: Record<string, LspCompletionDocumentState>;
  symbolsByDocument: Record<string, LspDocumentSymbolItem[]>;
  symbolsReadAtByDocument: Record<string, string>;
  statusByLanguage: Partial<Record<LspLanguage, LspStatus>>;
  openDocuments: Record<string, LspDocumentRef>;
  setDiagnostics(workspaceId: WorkspaceId, path: string, diagnostics: LspDiagnostic[]): void;
  applyDiagnosticsResult(result: LspDiagnosticsReadResult): void;
  applyDiagnosticsEvent(event: LspDiagnosticsEvent): void;
  clearDiagnostics(workspaceId: WorkspaceId, path: string): void;
  getDiagnostics(workspaceId: WorkspaceId, path: string): LspDiagnostic[];
  setCompletionItems(workspaceId: WorkspaceId, path: string, items: LspCompletionItem[]): void;
  applyCompletionResult(result: LspCompletionProviderResult): void;
  getCompletionItems(workspaceId: WorkspaceId, path: string): LspCompletionItem[];
  getCompletionState(workspaceId: WorkspaceId, path: string): LspCompletionDocumentState | null;
  setSymbols(workspaceId: WorkspaceId, path: string, symbols: LspDocumentSymbolItem[]): void;
  applySymbolsResult(result: LspDocumentSymbolsProviderResult): void;
  getSymbols(workspaceId: WorkspaceId, path: string): LspDocumentSymbolItem[];
  setStatus(status: LspStatus): void;
  applyStatusResult(result: LspStatusReadResult): void;
  applyStatusEvent(event: LspStatusEvent): void;
  getStatus(language: LspLanguage): LspStatus | null;
  openDocument(document: LspDocumentRef): void;
  applyDocumentOpenResult(result: LspDocumentOpenResult, document?: Partial<Pick<LspDocumentRef, "content" | "version">>): void;
  changeDocument(input: LspDocumentChangeInput): void;
  applyDocumentChangeResult(
    result: LspDocumentChangeResult,
    change?: Partial<Pick<LspDocumentChangeInput, "content" | "version">>,
  ): void;
  closeDocument(workspaceId: WorkspaceId, path: string): void;
  applyDocumentCloseResult(result: LspDocumentCloseResult): void;
  getOpenDocument(workspaceId: WorkspaceId, path: string): LspDocumentRef | null;
  isDocumentOpen(workspaceId: WorkspaceId, path: string): boolean;
}

export type LspServiceStore = StoreApi<ILspService>;
export type LspServiceState = Pick<
  ILspService,
  | "diagnosticsByDocument"
  | "diagnosticsReadAtByDocument"
  | "completionItemsByDocument"
  | "completionStateByDocument"
  | "symbolsByDocument"
  | "symbolsReadAtByDocument"
  | "statusByLanguage"
  | "openDocuments"
>;

const DEFAULT_LSP_STATE: LspServiceState = {
  diagnosticsByDocument: {},
  diagnosticsReadAtByDocument: {},
  completionItemsByDocument: {},
  completionStateByDocument: {},
  symbolsByDocument: {},
  symbolsReadAtByDocument: {},
  statusByLanguage: {},
  openDocuments: {},
};

export function createLspService(
  initialState: Partial<LspServiceState> = {},
): LspServiceStore {
  return createStore<ILspService>((set, get) => ({
    ...DEFAULT_LSP_STATE,
    ...initialState,
    setDiagnostics(workspaceId, path, diagnostics) {
      const key = documentKey(workspaceId, path);
      set((state) => ({
        diagnosticsByDocument: {
          ...state.diagnosticsByDocument,
          [key]: diagnostics,
        },
      }));
    },
    applyDiagnosticsResult(result) {
      set((state) => {
        const diagnosticsByDocument = { ...state.diagnosticsByDocument };
        const diagnosticsReadAtByDocument = { ...state.diagnosticsReadAtByDocument };
        for (const [path, diagnostics] of groupDiagnosticsByPath(result.diagnostics)) {
          const key = documentKey(result.workspaceId, path);
          diagnosticsByDocument[key] = diagnostics;
          diagnosticsReadAtByDocument[key] = result.readAt;
        }

        return { diagnosticsByDocument, diagnosticsReadAtByDocument };
      });
    },
    applyDiagnosticsEvent(event) {
      const key = documentKey(event.workspaceId, event.path);
      set((state) => ({
        diagnosticsByDocument: {
          ...state.diagnosticsByDocument,
          [key]: event.diagnostics,
        },
        diagnosticsReadAtByDocument: {
          ...state.diagnosticsReadAtByDocument,
          [key]: event.publishedAt,
        },
      }));
    },
    clearDiagnostics(workspaceId, path) {
      const key = documentKey(workspaceId, path);
      set((state) => ({
        diagnosticsByDocument: omitRecordKey(state.diagnosticsByDocument, key),
        diagnosticsReadAtByDocument: omitRecordKey(state.diagnosticsReadAtByDocument, key),
      }));
    },
    getDiagnostics(workspaceId, path) {
      return get().diagnosticsByDocument[documentKey(workspaceId, path)] ?? [];
    },
    setCompletionItems(workspaceId, path, items) {
      const key = documentKey(workspaceId, path);
      set((state) => ({
        completionItemsByDocument: {
          ...state.completionItemsByDocument,
          [key]: items,
        },
        completionStateByDocument: {
          ...state.completionStateByDocument,
          [key]: {
            items,
            isIncomplete: false,
            completedAt: null,
          },
        },
      }));
    },
    applyCompletionResult(result) {
      const key = documentKey(result.workspaceId, result.path);
      set((state) => ({
        completionItemsByDocument: {
          ...state.completionItemsByDocument,
          [key]: result.items,
        },
        completionStateByDocument: {
          ...state.completionStateByDocument,
          [key]: {
            items: result.items,
            isIncomplete: result.isIncomplete,
            completedAt: result.completedAt,
          },
        },
      }));
    },
    getCompletionItems(workspaceId, path) {
      return get().completionItemsByDocument[documentKey(workspaceId, path)] ?? [];
    },
    getCompletionState(workspaceId, path) {
      return get().completionStateByDocument[documentKey(workspaceId, path)] ?? null;
    },
    setSymbols(workspaceId, path, symbols) {
      const key = documentKey(workspaceId, path);
      set((state) => ({
        symbolsByDocument: {
          ...state.symbolsByDocument,
          [key]: symbols,
        },
      }));
    },
    applySymbolsResult(result) {
      const key = documentKey(result.workspaceId, result.path);
      set((state) => ({
        symbolsByDocument: {
          ...state.symbolsByDocument,
          [key]: result.symbols,
        },
        symbolsReadAtByDocument: {
          ...state.symbolsReadAtByDocument,
          [key]: result.readAt,
        },
      }));
    },
    getSymbols(workspaceId, path) {
      return get().symbolsByDocument[documentKey(workspaceId, path)] ?? [];
    },
    setStatus(status) {
      set((state) => ({
        statusByLanguage: {
          ...state.statusByLanguage,
          [status.language]: status,
        },
      }));
    },
    applyStatusResult(result) {
      set((state) => ({
        statusByLanguage: result.statuses.reduce(
          (statusByLanguage, status) => ({
            ...statusByLanguage,
            [status.language]: status,
          }),
          state.statusByLanguage,
        ),
      }));
    },
    applyStatusEvent(event) {
      get().setStatus(event.status);
    },
    getStatus(language) {
      return get().statusByLanguage[language] ?? null;
    },
    openDocument(document) {
      set((state) => ({
        openDocuments: {
          ...state.openDocuments,
          [documentKey(document.workspaceId, document.path)]: document,
        },
      }));
    },
    applyDocumentOpenResult(result, document = {}) {
      const version = document.version ?? get().openDocuments[documentKey(result.workspaceId, result.path)]?.version ?? 1;
      get().openDocument({
        workspaceId: result.workspaceId,
        path: result.path,
        language: result.language,
        version,
        content: document.content ?? null,
        openedAt: result.openedAt,
        changedAt: null,
      });
      get().setStatus(result.status);
    },
    changeDocument(input) {
      set((state) => {
        const key = documentKey(input.workspaceId, input.path);
        const existingDocument = state.openDocuments[key];
        const languageChanged = existingDocument !== undefined && existingDocument.language !== input.language;
        return {
          openDocuments: {
            ...state.openDocuments,
            [key]: {
              workspaceId: input.workspaceId,
              path: input.path,
              language: input.language,
              version: input.version,
              content: input.content ?? existingDocument?.content ?? null,
              openedAt: existingDocument?.openedAt ?? null,
              changedAt: input.changedAt ?? new Date().toISOString(),
            } satisfies LspDocumentRef,
          },
          diagnosticsByDocument: languageChanged
            ? omitRecordKey(state.diagnosticsByDocument, key)
            : state.diagnosticsByDocument,
          diagnosticsReadAtByDocument: languageChanged
            ? omitRecordKey(state.diagnosticsReadAtByDocument, key)
            : state.diagnosticsReadAtByDocument,
          completionItemsByDocument: languageChanged
            ? omitRecordKey(state.completionItemsByDocument, key)
            : state.completionItemsByDocument,
          completionStateByDocument: languageChanged
            ? omitRecordKey(state.completionStateByDocument, key)
            : state.completionStateByDocument,
          symbolsByDocument: languageChanged
            ? omitRecordKey(state.symbolsByDocument, key)
            : state.symbolsByDocument,
          symbolsReadAtByDocument: languageChanged
            ? omitRecordKey(state.symbolsReadAtByDocument, key)
            : state.symbolsReadAtByDocument,
        };
      });
    },
    applyDocumentChangeResult(result, change = {}) {
      const existingDocument = get().openDocuments[documentKey(result.workspaceId, result.path)];
      get().changeDocument({
        workspaceId: result.workspaceId,
        path: result.path,
        language: result.language,
        version: change.version ?? existingDocument?.version ?? 1,
        content: change.content ?? existingDocument?.content ?? null,
        changedAt: result.changedAt,
      });
      get().setStatus(result.status);
    },
    closeDocument(workspaceId, path) {
      const key = documentKey(workspaceId, path);
      set((state) => ({
        openDocuments: omitRecordKey(state.openDocuments, key),
        diagnosticsByDocument: omitRecordKey(state.diagnosticsByDocument, key),
        diagnosticsReadAtByDocument: omitRecordKey(state.diagnosticsReadAtByDocument, key),
        completionItemsByDocument: omitRecordKey(state.completionItemsByDocument, key),
        completionStateByDocument: omitRecordKey(state.completionStateByDocument, key),
        symbolsByDocument: omitRecordKey(state.symbolsByDocument, key),
        symbolsReadAtByDocument: omitRecordKey(state.symbolsReadAtByDocument, key),
      }));
    },
    applyDocumentCloseResult(result) {
      get().closeDocument(result.workspaceId, result.path);
    },
    getOpenDocument(workspaceId, path) {
      return get().openDocuments[documentKey(workspaceId, path)] ?? null;
    },
    isDocumentOpen(workspaceId, path) {
      return get().openDocuments[documentKey(workspaceId, path)] !== undefined;
    },
  }));
}

function documentKey(workspaceId: WorkspaceId, path: string): string {
  return `${workspaceId}:${path}`;
}

function groupDiagnosticsByPath(diagnostics: readonly LspDiagnostic[]): Map<string, LspDiagnostic[]> {
  const byPath = new Map<string, LspDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    byPath.set(diagnostic.path, [...(byPath.get(diagnostic.path) ?? []), diagnostic]);
  }
  return byPath;
}

function omitRecordKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}
