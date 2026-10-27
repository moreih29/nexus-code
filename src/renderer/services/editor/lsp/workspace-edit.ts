// Workspace edit application — batches LSP text edits and applies them to Monaco models.
// No module-level state — monaco instance is passed as a parameter.

import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  TextEdit,
  WorkspaceDocumentChange,
} from "../../../../shared/lsp";
import { lspRangeToMonacoRange } from "./monaco-converters";

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

/** Where the edit's `file://` URIs and document versions resolve. */
export interface WorkspaceEditTarget {
  /**
   * Workspace of the server that sent the edit. Its models are keyed by
   * `nexus-ws://` workspace URIs, so each `file://` URI is mapped to that
   * form first.
   */
  workspaceId?: string;
  /**
   * The document version the server knows for `model` (the one the last
   * didOpen/didChange carried). Falls back to Monaco's version id.
   */
  lspVersionOf?: (model: Monaco.editor.ITextModel) => number | undefined;
}

function modelForUri(
  monaco: typeof Monaco,
  uri: string,
  target: WorkspaceEditTarget,
): Monaco.editor.ITextModel | null {
  if (target.workspaceId) {
    const absolutePath = fileUriToAbsolutePath(uri);
    if (absolutePath !== null) {
      const cacheUri = workspaceUriFor(target.workspaceId, absolutePath);
      const model = monaco.editor.getModel(monaco.Uri.parse(cacheUri));
      if (model) return model;
    }
  }
  return monaco.editor.getModel(monaco.Uri.parse(uri));
}

function collectDocumentChanges(
  monaco: typeof Monaco,
  documentChanges: WorkspaceDocumentChange[],
  target: WorkspaceEditTarget,
): ModelEditBatch[] | null {
  const batches = new Map<string, ModelEditBatch>();

  for (const change of documentChanges) {
    if (!isTextDocumentEdit(change)) return null;

    const { uri, version } = change.textDocument;
    const model = modelForUri(monaco, uri, target);
    if (!model) return null;
    const currentVersion = target.lspVersionOf?.(model) ?? model.getVersionId();
    if (version !== null && currentVersion !== version) return null;

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
  target: WorkspaceEditTarget,
): ModelEditBatch[] | null {
  const batches: ModelEditBatch[] = [];

  for (const [uri, edits] of Object.entries(changes)) {
    const model = modelForUri(monaco, uri, target);
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
  target: WorkspaceEditTarget = {},
): ApplyWorkspaceEditResult {
  const { edit } = params;
  const batches =
    edit.documentChanges !== undefined
      ? collectDocumentChanges(monaco, edit.documentChanges, target)
      : collectChangesMap(monaco, edit.changes ?? {}, target);

  if (!batches) return { applied: false };

  applyEditBatches(batches);
  return { applied: true };
}
