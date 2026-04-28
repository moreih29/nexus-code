import type {
  LspDocumentSymbol,
  LspDocumentSymbolItem,
  LspDocumentSymbolsRequest,
  LspDocumentSymbolsResult,
  LspLanguage,
  LspSymbolInformation,
  LspSymbolKind,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { mapRangeToMonaco } from "./read-provider-mapping";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;
type MonacoDocumentSymbol = import("monaco-editor").languages.DocumentSymbol;
type MonacoSymbolKindMap = typeof import("monaco-editor").languages.SymbolKind;

export interface LspDocumentSymbolsEditorApi {
  invoke(request: LspDocumentSymbolsRequest): Promise<LspDocumentSymbolsResult>;
}

export interface RegisterLspDocumentSymbolsProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspDocumentSymbolsEditorApi;
}

export function registerLspDocumentSymbolsProvider(
  monaco: MonacoApi,
  options: RegisterLspDocumentSymbolsProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerDocumentSymbolProvider(options.languageId, {
    displayName: "Nexus LSP",
    provideDocumentSymbols: async (model) => {
      if (model !== options.model) {
        return [];
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-document-symbols/read",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
        });

        return mapLspDocumentSymbolsToMonaco(monaco, result);
      } catch (error) {
        console.error(
          "Monaco document symbols provider: document symbols request failed.",
          error,
        );
        return [];
      }
    },
  });
}

export function mapLspDocumentSymbolsToMonaco(
  monaco: MonacoApi,
  result: LspDocumentSymbolsResult,
): MonacoDocumentSymbol[] {
  return result.symbols.map((symbol) => mapDocumentSymbolItemToMonaco(monaco, symbol));
}

export function mapDocumentSymbolItemToMonaco(
  monaco: MonacoApi,
  symbol: LspDocumentSymbolItem,
): MonacoDocumentSymbol {
  return symbol.type === "symbol-information"
    ? mapSymbolInformationToMonaco(monaco, symbol)
    : mapDocumentSymbolToMonaco(monaco, symbol);
}

export function mapDocumentSymbolToMonaco(
  monaco: MonacoApi,
  symbol: LspDocumentSymbol,
): MonacoDocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: mapSymbolKindToMonaco(symbol.kind, monaco.languages.SymbolKind),
    tags: mapSymbolTagsToMonaco(monaco, symbol.tags),
    range: mapRangeToMonaco(monaco, symbol.range),
    selectionRange: mapRangeToMonaco(monaco, symbol.selectionRange),
    children: symbol.children.map((child) => mapDocumentSymbolToMonaco(monaco, child)),
  };
}

export function mapSymbolInformationToMonaco(
  monaco: MonacoApi,
  symbol: LspSymbolInformation,
): MonacoDocumentSymbol {
  return {
    name: symbol.name,
    detail: "",
    kind: mapSymbolKindToMonaco(symbol.kind, monaco.languages.SymbolKind),
    tags: mapSymbolTagsToMonaco(monaco, symbol.tags),
    containerName: symbol.containerName ?? undefined,
    range: mapRangeToMonaco(monaco, symbol.location.range),
    selectionRange: mapRangeToMonaco(monaco, symbol.location.range),
    children: [],
  };
}

export function mapSymbolKindToMonaco(
  kind: LspSymbolKind,
  symbolKind: MonacoSymbolKindMap,
): number {
  switch (kind) {
    case "file":
      return symbolKind.File;
    case "module":
      return symbolKind.Module;
    case "namespace":
      return symbolKind.Namespace;
    case "package":
      return symbolKind.Package;
    case "class":
      return symbolKind.Class;
    case "method":
      return symbolKind.Method;
    case "property":
      return symbolKind.Property;
    case "field":
      return symbolKind.Field;
    case "constructor":
      return symbolKind.Constructor;
    case "enum":
      return symbolKind.Enum;
    case "interface":
      return symbolKind.Interface;
    case "function":
      return symbolKind.Function;
    case "constant":
      return symbolKind.Constant;
    case "string":
      return symbolKind.String;
    case "number":
      return symbolKind.Number;
    case "boolean":
      return symbolKind.Boolean;
    case "array":
      return symbolKind.Array;
    case "object":
      return symbolKind.Object;
    case "key":
      return symbolKind.Key;
    case "null":
      return symbolKind.Null;
    case "enum-member":
      return symbolKind.EnumMember;
    case "struct":
      return symbolKind.Struct;
    case "event":
      return symbolKind.Event;
    case "operator":
      return symbolKind.Operator;
    case "type-parameter":
      return symbolKind.TypeParameter;
    case "variable":
    default:
      return symbolKind.Variable;
  }
}

function mapSymbolTagsToMonaco(
  monaco: MonacoApi,
  tags: readonly string[],
): import("monaco-editor").languages.SymbolTag[] {
  return tags.includes("deprecated") ? [monaco.languages.SymbolTag.Deprecated] : [];
}
