import type { LspDiagnostic, LspDiagnosticSeverity } from "../../../../shared/src/contracts/editor/editor-bridge";

export interface MonacoMarkerSeverityMap {
  Error: number;
  Warning: number;
  Info: number;
  Hint: number;
}

export interface MonacoMarkerDataLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: number;
  message: string;
  source?: string;
  code?: string;
}

export function mapLspDiagnosticsToMonacoMarkers(
  diagnostics: readonly LspDiagnostic[],
  markerSeverity: MonacoMarkerSeverityMap,
): MonacoMarkerDataLike[] {
  return diagnostics.map((diagnostic) => {
    const startLineNumber = diagnostic.range.start.line + 1;
    const startColumn = diagnostic.range.start.character + 1;
    const rawEndLineNumber = diagnostic.range.end.line + 1;
    const rawEndColumn = diagnostic.range.end.character + 1;
    const endLineNumber = Math.max(startLineNumber, rawEndLineNumber);
    const endColumn = endLineNumber === startLineNumber
      ? Math.max(startColumn + 1, rawEndColumn)
      : Math.max(1, rawEndColumn);

    return {
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
      severity: mapDiagnosticSeverity(diagnostic.severity, markerSeverity),
      message: diagnostic.message,
      source: diagnostic.source ?? undefined,
      code: diagnostic.code === null || diagnostic.code === undefined
        ? undefined
        : String(diagnostic.code),
    };
  });
}

export function mapDiagnosticSeverity(
  severity: LspDiagnosticSeverity,
  markerSeverity: MonacoMarkerSeverityMap,
): number {
  switch (severity) {
    case "error":
      return markerSeverity.Error;
    case "warning":
      return markerSeverity.Warning;
    case "information":
      return markerSeverity.Info;
    case "hint":
      return markerSeverity.Hint;
  }
}
