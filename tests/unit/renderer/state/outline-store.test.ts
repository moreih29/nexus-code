import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DocumentSymbol } from "../../../../src/shared/lsp-types";

const fetchDocumentSymbols = mock((_uri: string, _signal?: AbortSignal) =>
  Promise.resolve([] as DocumentSymbol[]),
);

const {
  __resetOutlineStoreForTests,
  __setDocumentSymbolFetcherForTests,
  bindOutlineToModelRelease,
  useOutlineStore,
} = await import("../../../../src/renderer/state/stores/outline");

const URI = "file:///workspace/src/module.py";

const SYMBOLS: DocumentSymbol[] = [
  {
    name: "Greeter",
    kind: 5,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 4, character: 0 },
    },
    selectionRange: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 13 },
    },
    children: [
      {
        name: "greet",
        kind: 6,
        range: {
          start: { line: 1, character: 2 },
          end: { line: 2, character: 24 },
        },
        selectionRange: {
          start: { line: 1, character: 6 },
          end: { line: 1, character: 11 },
        },
        children: [],
      },
    ],
  },
];

beforeEach(() => {
  __resetOutlineStoreForTests();
  fetchDocumentSymbols.mockReset();
  fetchDocumentSymbols.mockImplementation(() => Promise.resolve([] as DocumentSymbol[]));
  __setDocumentSymbolFetcherForTests(fetchDocumentSymbols);
});

afterEach(() => {
  __resetOutlineStoreForTests();
});

describe("outline store", () => {
  test("enters loading while document symbols are in flight, then stores ready symbols", async () => {
    let resolveFetch!: (symbols: DocumentSymbol[]) => void;
    fetchDocumentSymbols.mockImplementation(
      () => new Promise<DocumentSymbol[]>((resolve) => (resolveFetch = resolve)),
    );

    const loadPromise = useOutlineStore.getState().load(URI);

    expect(useOutlineStore.getState().entries.get(URI)?.phase).toBe("loading");

    resolveFetch(SYMBOLS);
    await loadPromise;

    expect(useOutlineStore.getState().entries.get(URI)).toMatchObject({
      phase: "ready",
      symbols: SYMBOLS,
    });
  });

  test("stores error state when document symbol fetch fails", async () => {
    fetchDocumentSymbols.mockImplementation(() => Promise.reject(new Error("server unavailable")));

    await useOutlineStore.getState().load(URI);

    expect(useOutlineStore.getState().entries.get(URI)).toMatchObject({
      phase: "error",
      symbols: [],
      errorMessage: "server unavailable",
    });
  });

  test("clearUri removes cached symbols and cursor state for a single URI", async () => {
    fetchDocumentSymbols.mockImplementation(() => Promise.resolve(SYMBOLS));

    await useOutlineStore.getState().load(URI);
    useOutlineStore.getState().setCursorPosition(URI, { line: 1, character: 8 });

    useOutlineStore.getState().clearUri(URI);

    expect(useOutlineStore.getState().entries.has(URI)).toBe(false);
    expect(useOutlineStore.getState().cursorByUri.has(URI)).toBe(false);
  });

  test("clearAll removes all outline caches", async () => {
    fetchDocumentSymbols.mockImplementation(() => Promise.resolve(SYMBOLS));

    await useOutlineStore.getState().load(URI);
    await useOutlineStore.getState().load("file:///workspace/src/other.py", undefined, {
      force: true,
    });

    useOutlineStore.getState().clearAll();

    expect(useOutlineStore.getState().entries.size).toBe(0);
  });

  test("release invalidation clears the released model URI", async () => {
    fetchDocumentSymbols.mockImplementation(() => Promise.resolve(SYMBOLS));
    let releaseCallback!: (released: { cacheUri: string; lspUri?: string }) => void;
    const unsubscribe = bindOutlineToModelRelease((callback) => {
      releaseCallback = callback;
      return () => {};
    });

    await useOutlineStore.getState().load(URI);
    useOutlineStore.getState().setCursorPosition(URI, { line: 1, character: 8 });

    releaseCallback({ cacheUri: URI });

    expect(useOutlineStore.getState().entries.has(URI)).toBe(false);
    expect(useOutlineStore.getState().cursorByUri.has(URI)).toBe(false);
    unsubscribe();
  });

  test("release invalidation clears both cache and LSP URI when they differ", async () => {
    const lspUri = "file:///workspace/src/module%20copy.py";
    fetchDocumentSymbols.mockImplementation(() => Promise.resolve(SYMBOLS));
    let releaseCallback!: (released: { cacheUri: string; lspUri?: string }) => void;
    bindOutlineToModelRelease((callback) => {
      releaseCallback = callback;
      return () => {};
    });

    await useOutlineStore.getState().load(URI);
    await useOutlineStore.getState().load(lspUri, undefined, { force: true });

    releaseCallback({ cacheUri: URI, lspUri });

    expect(useOutlineStore.getState().entries.has(URI)).toBe(false);
    expect(useOutlineStore.getState().entries.has(lspUri)).toBe(false);
  });
});
