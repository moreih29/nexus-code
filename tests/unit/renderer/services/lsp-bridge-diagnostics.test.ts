import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  applyWorkspaceEdit,
  lspDiagnosticToMonacoMarker,
  monacoContentChangesToLsp,
  tokenToAbortSignal,
} from "../../../../src/renderer/services/editor/lsp-bridge";
import type { Diagnostic } from "../../../../src/shared/lsp-types";

interface FakeUri {
  readonly raw: string;
}

interface FakeTextModel {
  readonly uri: FakeUri;
  readonly appliedEdits: unknown[][];
  getVersionId(): number;
  applyEdits(edits: unknown[]): void;
}

function createFakeMonaco(): typeof Monaco {
  return {
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    Uri: {
      parse: (raw: string) => ({ raw }) as unknown as Monaco.Uri,
    },
  } as unknown as typeof Monaco;
}

const monaco = createFakeMonaco();

function createApplyEditMonaco(models: Map<string, FakeTextModel>): typeof Monaco {
  return {
    Uri: {
      parse: (raw: string) => ({ raw }) as unknown as Monaco.Uri,
    },
    editor: {
      getModel: (uri: FakeUri) =>
        (models.get(uri.raw) ?? null) as unknown as Monaco.editor.ITextModel | null,
    },
  } as unknown as typeof Monaco;
}

function createFakeModel(uri: string, versionId: number): FakeTextModel {
  return {
    uri: { raw: uri },
    appliedEdits: [],
    getVersionId: () => versionId,
    applyEdits(edits: unknown[]) {
      this.appliedEdits.push(edits);
    },
  };
}

const range = {
  start: { line: 2, character: 4 },
  end: { line: 2, character: 11 },
};

function diagnostic(input: Partial<Diagnostic> = {}): Diagnostic {
  return {
    range,
    message: "fixture diagnostic",
    ...input,
  };
}

describe("lspDiagnosticToMonacoMarker", () => {
  test("maps zero-based LSP ranges to one-based Monaco marker ranges", () => {
    const marker = lspDiagnosticToMonacoMarker(
      monaco,
      diagnostic({
        range: {
          start: { line: 0, character: 1 },
          end: { line: 3, character: 8 },
        },
      }),
    );

    expect(marker).toMatchObject({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 4,
      endColumn: 9,
    });
  });

  test("maps LSP diagnostic severities 1-4 to Monaco severities", () => {
    const severities = ([1, 2, 3, 4] as const).map(
      (severity) => lspDiagnosticToMonacoMarker(monaco, diagnostic({ severity })).severity,
    );

    expect(severities).toEqual([
      monaco.MarkerSeverity.Error,
      monaco.MarkerSeverity.Warning,
      monaco.MarkerSeverity.Info,
      monaco.MarkerSeverity.Hint,
    ]);
  });

  test("maps Unnecessary and Deprecated diagnostic tags", () => {
    const marker = lspDiagnosticToMonacoMarker(monaco, diagnostic({ tags: [1, 2] }));

    expect(marker.tags).toEqual([monaco.MarkerTag.Unnecessary, monaco.MarkerTag.Deprecated]);
  });

  test("maps codeDescription href to a Monaco code target URI", () => {
    const marker = lspDiagnosticToMonacoMarker(
      monaco,
      diagnostic({
        code: "reportMissingImports",
        codeDescription: { href: "https://example.invalid/diagnostics/reportMissingImports" },
      }),
    );

    expect(marker.code).toEqual({
      value: "reportMissingImports",
      target: {
        raw: "https://example.invalid/diagnostics/reportMissingImports",
      } satisfies FakeUri,
    });
  });

  test("maps diagnostic source and relatedInformation locations", () => {
    const marker = lspDiagnosticToMonacoMarker(
      monaco,
      diagnostic({
        source: "Pyright",
        relatedInformation: [
          {
            location: {
              uri: "file:///workspace/types.py",
              range: {
                start: { line: 10, character: 2 },
                end: { line: 10, character: 7 },
              },
            },
            message: "Type defined here",
          },
        ],
      }),
    );

    expect(marker.source).toBe("Pyright");
    expect(marker.relatedInformation).toEqual([
      {
        resource: { raw: "file:///workspace/types.py" } satisfies FakeUri,
        message: "Type defined here",
        startLineNumber: 11,
        startColumn: 3,
        endLineNumber: 11,
        endColumn: 8,
      },
    ]);
  });

  test("handles optional diagnostic fields when they are undefined", () => {
    const marker = lspDiagnosticToMonacoMarker(monaco, diagnostic());

    expect(marker.severity).toBe(monaco.MarkerSeverity.Error);
    expect(marker.code).toBeUndefined();
    expect(marker.source).toBeUndefined();
    expect(marker.tags).toBeUndefined();
    expect(marker.relatedInformation).toBeUndefined();
  });
});

describe("monacoContentChangesToLsp", () => {
  test("maps Monaco one-based ranges to LSP zero-based incremental changes in order", () => {
    const changes = [
      {
        range: {
          startLineNumber: 3,
          startColumn: 5,
          endLineNumber: 3,
          endColumn: 8,
        },
        rangeOffset: 20,
        rangeLength: 3,
        text: "abc",
        forceMoveMarkers: false,
      },
      {
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        },
        rangeOffset: 0,
        rangeLength: 0,
        text: "first",
        forceMoveMarkers: false,
      },
    ] as Monaco.editor.IModelContentChange[];

    expect(monacoContentChangesToLsp(changes)).toEqual([
      {
        range: {
          start: { line: 2, character: 4 },
          end: { line: 2, character: 7 },
        },
        rangeLength: 3,
        text: "abc",
      },
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        rangeLength: 0,
        text: "first",
      },
    ]);
  });
});

describe("applyWorkspaceEdit", () => {
  test("applies changes-map text edits to an open Monaco model", () => {
    const uri = "file:///workspace/main.ts";
    const model = createFakeModel(uri, 1);
    const models = new Map([[uri, model]]);
    const result = applyWorkspaceEdit(createApplyEditMonaco(models), {
      edit: {
        changes: {
          [uri]: [{ range, newText: "updated" }],
        },
      },
    });

    expect(result).toEqual({ applied: true });
    expect(model.appliedEdits).toEqual([
      [
        {
          range: {
            startLineNumber: 3,
            startColumn: 5,
            endLineNumber: 3,
            endColumn: 12,
          },
          text: "updated",
          forceMoveMarkers: true,
        },
      ],
    ]);
  });

  test("applies versioned documentChanges when the model version matches", () => {
    const uri = "file:///workspace/versioned.ts";
    const model = createFakeModel(uri, 7);
    const models = new Map([[uri, model]]);
    const result = applyWorkspaceEdit(createApplyEditMonaco(models), {
      edit: {
        documentChanges: [
          {
            textDocument: { uri, version: 7 },
            edits: [{ range, newText: "matched" }],
          },
        ],
      },
    });

    expect(result).toEqual({ applied: true });
    expect(model.appliedEdits).toHaveLength(1);
  });

  test("rejects versioned documentChanges when the model version is stale", () => {
    const uri = "file:///workspace/stale.ts";
    const model = createFakeModel(uri, 8);
    const models = new Map([[uri, model]]);
    const result = applyWorkspaceEdit(createApplyEditMonaco(models), {
      edit: {
        documentChanges: [
          {
            textDocument: { uri, version: 7 },
            edits: [{ range, newText: "stale" }],
          },
        ],
      },
    });

    expect(result).toEqual({ applied: false });
    expect(model.appliedEdits).toEqual([]);
  });

  test("rejects resource operations without applying any edits", () => {
    const result = applyWorkspaceEdit(createApplyEditMonaco(new Map()), {
      edit: {
        documentChanges: [{ kind: "create", uri: "file:///workspace/new.ts" }],
      },
    });

    expect(result).toEqual({ applied: false });
  });
});

describe("tokenToAbortSignal", () => {
  test("returns an already-aborted signal when the Monaco token is already cancelled", () => {
    const token = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as Monaco.CancellationToken;

    const signal = tokenToAbortSignal(token);

    expect(signal.aborted).toBe(true);
  });

  test("aborts the signal when the Monaco token fires cancellation", () => {
    let listener: (() => void) | null = null;
    let disposed = false;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (cb: () => void) => {
        listener = cb;
        return {
          dispose: () => {
            disposed = true;
          },
        };
      },
    } as unknown as Monaco.CancellationToken;

    const signal = tokenToAbortSignal(token);
    expect(signal.aborted).toBe(false);

    listener?.();

    expect(signal.aborted).toBe(true);
    expect(disposed).toBe(true);
  });
});
