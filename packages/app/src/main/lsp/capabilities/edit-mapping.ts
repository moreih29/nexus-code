import type {
  Diagnostic as ProtocolDiagnostic,
  Range as ProtocolRange,
  TextEdit as ProtocolTextEdit,
} from "vscode-languageserver-protocol";

import type {
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspLanguage,
  LspTextEdit,
  LspWorkspaceEdit,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import {
  finiteInteger,
  isProtocolRange,
  isRecord,
  mapFileUriToWorkspacePath,
  mapProtocolRange,
} from "./read-mapping";

export function buildTextDocumentPositionParams(
  uri: string,
  position: { line: number; character: number },
): {
  textDocument: { uri: string };
  position: { line: number; character: number };
} {
  return {
    textDocument: {
      uri,
    },
    position,
  };
}

export function mapProtocolTextEdits(response: unknown): LspTextEdit[] {
  if (!Array.isArray(response)) {
    return [];
  }

  return response.filter(isProtocolTextEdit).map(mapProtocolTextEdit);
}

export function mapProtocolTextEdit(edit: ProtocolTextEdit): LspTextEdit {
  return {
    range: mapProtocolRange(edit.range),
    newText: edit.newText,
  };
}

export function mapProtocolWorkspaceEdit(
  response: unknown,
  workspaceRoot: string,
): LspWorkspaceEdit {
  const changesByPath = new Map<string, LspTextEdit[]>();

  if (!isRecord(response)) {
    return { changes: [] };
  }

  if (isRecord(response.changes)) {
    for (const [uri, edits] of Object.entries(response.changes)) {
      appendWorkspaceEditChanges(changesByPath, workspaceRoot, uri, edits);
    }
  }

  if (Array.isArray(response.documentChanges)) {
    for (const documentChange of response.documentChanges) {
      if (!isRecord(documentChange) || !isRecord(documentChange.textDocument)) {
        continue;
      }
      if (typeof documentChange.textDocument.uri !== "string") {
        continue;
      }
      appendWorkspaceEditChanges(
        changesByPath,
        workspaceRoot,
        documentChange.textDocument.uri,
        documentChange.edits,
      );
    }
  }

  return {
    changes: Array.from(changesByPath.entries()).map(([path, edits]) => ({
      path,
      edits,
    })),
  };
}

export function mapSharedDiagnosticToProtocol(
  diagnostic: LspDiagnostic,
): ProtocolDiagnostic {
  return {
    range: diagnostic.range,
    severity: mapSeverityToProtocol(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? undefined,
    code: diagnostic.code ?? undefined,
  };
}

export function mapDocumentationToString(documentation: unknown): string | null {
  if (typeof documentation === "string") {
    return documentation;
  }

  if (isRecord(documentation) && typeof documentation.value === "string") {
    return documentation.value;
  }

  return null;
}

function appendWorkspaceEditChanges(
  changesByPath: Map<string, LspTextEdit[]>,
  workspaceRoot: string,
  uri: string,
  edits: unknown,
): void {
  if (!Array.isArray(edits)) {
    return;
  }

  const path = mapFileUriToWorkspacePath(workspaceRoot, uri).path;
  if (!path) {
    return;
  }

  const mappedEdits = edits.filter(isProtocolTextEdit).map(mapProtocolTextEdit);
  if (mappedEdits.length === 0) {
    return;
  }

  changesByPath.set(path, [...(changesByPath.get(path) ?? []), ...mappedEdits]);
}

function isProtocolTextEdit(value: unknown): value is ProtocolTextEdit {
  return (
    isRecord(value) &&
    isProtocolRange(value.range) &&
    typeof value.newText === "string"
  );
}

function mapSeverityToProtocol(severity: LspDiagnosticSeverity): number {
  switch (severity) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "information":
      return 3;
    case "hint":
      return 4;
  }
}

export function mapRangeToProtocol(range: ProtocolRange | undefined | null): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  return {
    start: {
      line: finiteInteger(range?.start.line),
      character: finiteInteger(range?.start.character),
    },
    end: {
      line: finiteInteger(range?.end.line),
      character: finiteInteger(range?.end.character),
    },
  };
}
