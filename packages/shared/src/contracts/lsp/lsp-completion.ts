import type { WorkspaceId } from "../workspace/workspace";
import type { LspLanguage, LspRange } from "./lsp-diagnostics";

export type LspCompletionItemKind =
  | "text"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "variable"
  | "class"
  | "interface"
  | "module"
  | "property"
  | "unit"
  | "value"
  | "enum"
  | "keyword"
  | "snippet"
  | "color"
  | "file"
  | "reference"
  | "folder"
  | "enum-member"
  | "constant"
  | "struct"
  | "event"
  | "operator"
  | "type-parameter";

export type LspCompletionInsertTextFormat = "plain-text" | "snippet";
export type LspCompletionTriggerKind =
  | "invoked"
  | "trigger-character"
  | "trigger-for-incomplete-completions";

export type LspCompletionEditRange =
  | LspRange
  | {
      insert: LspRange;
      replace: LspRange;
    };

export interface LspCompletionTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspCompletionItem {
  label: string;
  kind: LspCompletionItemKind;
  detail?: string | null;
  documentation?: string | null;
  sortText?: string | null;
  filterText?: string | null;
  insertText: string;
  insertTextFormat: LspCompletionInsertTextFormat;
  range?: LspCompletionEditRange | null;
  additionalTextEdits: LspCompletionTextEdit[];
  commitCharacters?: string[] | null;
  preselect?: boolean | null;
  deprecated?: boolean | null;
}

export interface LspCompletionRequest {
  type: "lsp-completion/complete";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
  triggerKind?: LspCompletionTriggerKind | null;
  triggerCharacter?: string | null;
}

export interface LspCompletionResult {
  type: "lsp-completion/complete/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  isIncomplete: boolean;
  items: LspCompletionItem[];
  completedAt: string;
}
