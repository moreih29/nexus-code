import { describe, expect, test } from "bun:test";

import type { LspDiagnostic } from "../../../../shared/src/contracts/editor/editor-bridge";
import { mapLspDiagnosticsToMonacoMarkers } from "./monaco-lsp-markers";

const severity = {
  Error: 8,
  Warning: 4,
  Info: 2,
  Hint: 1,
};

describe("Monaco LSP marker mapping", () => {
  test("maps zero-based LSP ranges and severities to Monaco marker data", () => {
    const diagnostics: LspDiagnostic[] = [
      {
        path: "src/index.ts",
        language: "typescript",
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        severity: "error",
        message: "Cannot find name 'value'.",
        source: "tsserver",
        code: 2304,
      },
      {
        path: "src/index.ts",
        language: "typescript",
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 0 },
        },
        severity: "hint",
        message: "Unused import.",
      },
    ];

    expect(mapLspDiagnosticsToMonacoMarkers(diagnostics, severity)).toEqual([
      {
        startLineNumber: 1,
        startColumn: 7,
        endLineNumber: 1,
        endColumn: 12,
        severity: 8,
        message: "Cannot find name 'value'.",
        source: "tsserver",
        code: "2304",
      },
      {
        startLineNumber: 3,
        startColumn: 1,
        endLineNumber: 3,
        endColumn: 2,
        severity: 1,
        message: "Unused import.",
        source: undefined,
        code: undefined,
      },
    ]);
  });
});
