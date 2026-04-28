import type { WorkspaceId } from "../workspace/workspace";
import type { LspLanguage, LspRange } from "./lsp-diagnostics";

export type LspHoverContentKind = "markdown" | "plaintext";

export interface LspHoverContent {
  kind: LspHoverContentKind;
  value: string;
}

export interface LspHoverRequest {
  type: "lsp-hover/read";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
}

export interface LspHoverResult {
  type: "lsp-hover/read/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  contents: LspHoverContent[];
  range?: LspRange | null;
  readAt: string;
}

export interface LspLocation {
  uri: string;
  path: string | null;
  range: LspRange;
}

export interface LspLocationLink {
  originSelectionRange?: LspRange | null;
  targetUri: string;
  targetPath: string | null;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export type LspDefinitionTarget =
  | ({ type: "location" } & LspLocation)
  | ({ type: "location-link" } & LspLocationLink);

export interface LspDefinitionRequest {
  type: "lsp-definition/read";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
}

export interface LspDefinitionResult {
  type: "lsp-definition/read/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  targets: LspDefinitionTarget[];
  readAt: string;
}

export interface LspReferencesRequest {
  type: "lsp-references/read";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  position: {
    line: number;
    character: number;
  };
  includeDeclaration?: boolean | null;
}

export interface LspReferencesResult {
  type: "lsp-references/read/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  locations: LspLocation[];
  readAt: string;
}

export type LspSymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enum-member"
  | "struct"
  | "event"
  | "operator"
  | "type-parameter";

export type LspSymbolTag = "deprecated";

export interface LspDocumentSymbol {
  type: "document-symbol";
  name: string;
  detail?: string | null;
  kind: LspSymbolKind;
  tags: LspSymbolTag[];
  range: LspRange;
  selectionRange: LspRange;
  children: LspDocumentSymbol[];
}

export interface LspSymbolInformation {
  type: "symbol-information";
  name: string;
  kind: LspSymbolKind;
  tags: LspSymbolTag[];
  containerName?: string | null;
  location: LspLocation;
}

export type LspDocumentSymbolItem = LspDocumentSymbol | LspSymbolInformation;

export interface LspDocumentSymbolsRequest {
  type: "lsp-document-symbols/read";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
}

export interface LspDocumentSymbolsResult {
  type: "lsp-document-symbols/read/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  symbols: LspDocumentSymbolItem[];
  readAt: string;
}
