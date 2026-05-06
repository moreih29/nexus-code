import { create } from "zustand";
import type { DocumentSymbol, Position } from "../../../shared/lsp-types";
import { fetchDocumentSymbols } from "../../services/editor/lsp-bridge";

export type OutlinePhase = "loading" | "ready" | "error";
export type DocumentSymbolFetcher = (
  uri: string,
  signal?: AbortSignal,
) => Promise<DocumentSymbol[]>;

export interface OutlineCacheEntry {
  phase: OutlinePhase;
  symbols: DocumentSymbol[];
  errorMessage?: string;
  requestId: number;
}

export interface ReleasedModelInfoLike {
  cacheUri: string;
  lspUri?: string;
}

export type SubscribeOnModelRelease = (
  callback: (released: ReleasedModelInfoLike) => void,
) => () => void;

interface LoadOptions {
  force?: boolean;
}

interface OutlineState {
  entries: Map<string, OutlineCacheEntry>;
  cursorByUri: Map<string, Position>;
  load(uri: string, signal?: AbortSignal, options?: LoadOptions): Promise<void>;
  clearUri(uri: string): void;
  clearAll(): void;
  setCursorPosition(uri: string, position: Position | null): void;
}

let nextRequestId = 0;
let documentSymbolFetcher: DocumentSymbolFetcher = fetchDocumentSymbols;

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "Unable to load outline.";
}

export const useOutlineStore = create<OutlineState>((set, get) => ({
  entries: new Map(),
  cursorByUri: new Map(),

  async load(uri, signal, options) {
    const existing = get().entries.get(uri);
    if (!options?.force && existing?.phase === "ready") return;

    const requestId = ++nextRequestId;
    set((state) => {
      const entries = new Map(state.entries);
      entries.set(uri, {
        phase: "loading",
        symbols: existing?.symbols ?? [],
        requestId,
      });
      return { entries };
    });

    try {
      const symbols = await documentSymbolFetcher(uri, signal);
      if (signal?.aborted) return;

      set((state) => {
        const current = state.entries.get(uri);
        if (!current || current.requestId !== requestId) return state;
        const entries = new Map(state.entries);
        entries.set(uri, { phase: "ready", symbols, requestId });
        return { entries };
      });
    } catch (error) {
      if (signal?.aborted) return;

      set((state) => {
        const current = state.entries.get(uri);
        if (!current || current.requestId !== requestId) return state;
        const entries = new Map(state.entries);
        entries.set(uri, {
          phase: "error",
          symbols: [],
          errorMessage: errorMessageFromUnknown(error),
          requestId,
        });
        return { entries };
      });
    }
  },

  clearUri(uri) {
    set((state) => {
      if (!state.entries.has(uri) && !state.cursorByUri.has(uri)) return state;
      const entries = new Map(state.entries);
      const cursorByUri = new Map(state.cursorByUri);
      entries.delete(uri);
      cursorByUri.delete(uri);
      return { entries, cursorByUri };
    });
  },

  clearAll() {
    set({ entries: new Map(), cursorByUri: new Map() });
  },

  setCursorPosition(uri, position) {
    set((state) => {
      const cursorByUri = new Map(state.cursorByUri);
      if (position) {
        cursorByUri.set(uri, position);
      } else {
        cursorByUri.delete(uri);
      }
      return { cursorByUri };
    });
  },
}));

export function bindOutlineToModelRelease(subscribeOnRelease: SubscribeOnModelRelease): () => void {
  return subscribeOnRelease((released) => {
    const { clearUri } = useOutlineStore.getState();
    clearUri(released.cacheUri);
    if (released.lspUri && released.lspUri !== released.cacheUri) {
      clearUri(released.lspUri);
    }
  });
}

export function __setDocumentSymbolFetcherForTests(fetcher: DocumentSymbolFetcher): void {
  documentSymbolFetcher = fetcher;
}

export function __resetOutlineStoreForTests(): void {
  documentSymbolFetcher = fetchDocumentSymbols;
  nextRequestId = 0;
  useOutlineStore.setState({ entries: new Map(), cursorByUri: new Map() });
}
