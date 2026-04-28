import type { WorkspaceId } from "../workspace/workspace";
import type { LspDiagnostic, LspLanguage, LspRange } from "./lsp-diagnostics";

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspWorkspaceEditChange {
  path: string;
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  changes: LspWorkspaceEditChange[];
}

export interface LspWorkspaceEditApplicationResult {
  applied: boolean;
  appliedPaths: string[];
  skippedClosedPaths: string[];
  skippedReadFailures: string[];
  skippedUnsupportedPaths: string[];
}

export interface LspPrepareRenameRequest {
  type: "lsp-rename/prepare";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
}

export interface LspPrepareRenameResult {
  type: "lsp-rename/prepare/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  canRename: boolean;
  range: LspRange | null;
  placeholder: string | null;
  defaultBehavior: boolean;
  preparedAt: string;
}

export interface LspRenameRequest {
  type: "lsp-rename/rename";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
  newName: string;
}

export interface LspRenameResult {
  type: "lsp-rename/rename/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  workspaceEdit: LspWorkspaceEdit;
  renamedAt: string;
}

export interface LspFormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace?: boolean | null;
  insertFinalNewline?: boolean | null;
  trimFinalNewlines?: boolean | null;
}

export interface LspDocumentFormattingRequest {
  type: "lsp-formatting/document";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  options: LspFormattingOptions;
}

export interface LspDocumentFormattingResult {
  type: "lsp-formatting/document/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  edits: LspTextEdit[];
  formattedAt: string;
}

export interface LspRangeFormattingRequest {
  type: "lsp-formatting/range";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  range: LspRange;
  options: LspFormattingOptions;
}

export interface LspRangeFormattingResult {
  type: "lsp-formatting/range/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  edits: LspTextEdit[];
  formattedAt: string;
}

export type LspSignatureHelpTriggerKind =
  | "invoked"
  | "trigger-character"
  | "content-change";

export interface LspSignatureHelpRequest {
  type: "lsp-signature-help/get";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
  triggerKind?: LspSignatureHelpTriggerKind | null;
  triggerCharacter?: string | null;
  isRetrigger?: boolean | null;
  activeSignatureHelp?: LspSignatureHelp | null;
}

export interface LspSignatureParameterInformation {
  label: string | [number, number];
  documentation?: string | null;
}

export interface LspSignatureInformation {
  label: string;
  documentation?: string | null;
  parameters: LspSignatureParameterInformation[];
  activeParameter?: number | null;
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

export interface LspSignatureHelpResult {
  type: "lsp-signature-help/get/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  signatureHelp: LspSignatureHelp | null;
  resolvedAt: string;
}

export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[] | null;
}

export interface LspCodeAction {
  title: string;
  kind?: string | null;
  diagnostics: LspDiagnostic[];
  edit?: LspWorkspaceEdit | null;
  command?: LspCommand | null;
  isPreferred?: boolean | null;
  disabledReason?: string | null;
}

export interface LspCodeActionRequest {
  type: "lsp-code-action/list";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  range: LspRange;
  diagnostics?: LspDiagnostic[] | null;
  only?: string | null;
}

export interface LspCodeActionResult {
  type: "lsp-code-action/list/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  actions: LspCodeAction[];
  listedAt: string;
}
