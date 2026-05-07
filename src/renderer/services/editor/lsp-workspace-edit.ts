// Workspace edit application — batches LSP text edits and applies them to Monaco models.
// No module-level state — monaco instance is passed as a parameter.

import type * as Monaco from "monaco-editor";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  TextEdit,
  WorkspaceDocumentChange,
} from "../../../shared/lsp-types";
import { lspRangeToMonacoRange } from "./lsp-monaco-converters";

function lspTextEditToMonacoEdit(edit: TextEdit): Monaco.editor.IIdentifiedSingleEditOperation {
  return {
    range: lspRangeToMonacoRange(edit.range),
    text: edit.newText,
    forceMoveMarkers: true,
  };
}

function isTextDocumentEdit(
  change: WorkspaceDocumentChange,
): change is Extract<WorkspaceDocumentChange, { textDocument: unknown }> {
  return "textDocument" in change;
}

type ModelEditBatch = {
  model: Monaco.editor.ITextModel;
  edits: TextEdit[];
};

function modelForUri(monaco: typeof Monaco, uri: string): Monaco.editor.ITextModel | null {
  return monaco.editor.getModel(monaco.Uri.parse(uri));
}

function collectDocumentChanges(
  monaco: typeof Monaco,
  documentChanges: WorkspaceDocumentChange[],
): ModelEditBatch[] | null {
  const batches = new Map<string, ModelEditBatch>();

  for (const change of documentChanges) {
    if (!isTextDocumentEdit(change)) return null;

    const { uri, version } = change.textDocument;
    const model = modelForUri(monaco, uri);
    if (!model) return null;
    if (version !== null && model.getVersionId() !== version) return null;

    const existing = batches.get(uri);
    if (existing) {
      existing.edits.push(...change.edits);
    } else {
      batches.set(uri, { model, edits: [...change.edits] });
    }
  }

  return [...batches.values()];
}

function collectChangesMap(
  monaco: typeof Monaco,
  changes: Record<string, TextEdit[]>,
): ModelEditBatch[] | null {
  const batches: ModelEditBatch[] = [];

  for (const [uri, edits] of Object.entries(changes)) {
    const model = modelForUri(monaco, uri);
    if (!model) return null;
    batches.push({ model, edits });
  }

  return batches;
}

function applyEditBatches(batches: ModelEditBatch[]): void {
  for (const batch of batches) {
    batch.model.applyEdits(batch.edits.map((edit) => lspTextEditToMonacoEdit(edit)));
  }
}

export function applyWorkspaceEdit(
  monaco: typeof Monaco,
  params: ApplyWorkspaceEditParams,
): ApplyWorkspaceEditResult {
  const { edit } = params;
  const batches =
    edit.documentChanges !== undefined
      ? collectDocumentChanges(monaco, edit.documentChanges)
      : collectChangesMap(monaco, edit.changes ?? {});

  if (!batches) return { applied: false };

  applyEditBatches(batches);
  return { applied: true };
}
